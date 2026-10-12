import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { BrowserResponse, BrowserTargetInfo } from '@ant/shared';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserManager } from '../src/browser/browser';
import { createComputerServer } from '../src/server';
import { auth, close, listen, post, tempDir, testConfig } from './helpers';

/** Chromium preinstalled for the pinned Playwright (PLAYWRIGHT_BROWSERS_PATH, /opt/pw-browsers by default). */
function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const PAGE = `<!doctype html><html><head><title>Page de test</title></head><body>
<h1>Bonjour Ant</h1>
<p>Un paragraphe visible.</p>
<label for="q">Recherche</label><input id="q" placeholder="Tape ici">
<input type="password" value="hunter2" placeholder="Mot de passe">
<input type="hidden" value="caché">
<button id="go" onclick="document.getElementById('out').textContent = 'Résultat : ' + document.getElementById('q').value">Valider</button>
<select id="color" aria-label="Couleur"><option value="r">Rouge</option><option value="b">Bleu</option></select>
<div role="tab">Onglet 1</div>
<a href="/second">Page suivante</a>
<button style="display:none">Invisible</button>
<p id="out"></p>
<div style="height:3000px"></div>
</body></html>`;

describe.skipIf(!chromiumAvailable())('browser (headless Chromium)', () => {
  let site: Server;
  let siteUrl: string;
  let server: Server;
  let base: string;
  let browser: BrowserManager;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/second' ? '<title>Deuxième</title><p>Seconde page</p>' : PAGE);
    });
    siteUrl = await listen(site);
    const t = await tempDir();
    cleanup = t.cleanup;
    const cfg = testConfig(path.join(t.dir), { browserProfileDir: path.join(t.dir, '.profile') });
    browser = new BrowserManager(cfg);
    server = createComputerServer({ cfg, browser });
    base = await listen(server);
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await close(server);
    if (site) await close(site);
    await cleanup?.();
  });

  const act = async (body: Record<string, unknown>): Promise<BrowserResponse> => {
    const r = await post<BrowserResponse>(base, '/browser', body);
    expect(r.status).toBe(200);
    return r.body;
  };

  it('goto refuses non-http URLs', async () => {
    const r = await act({ action: 'goto', url: 'file:///etc/passwd' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/http/);
  });

  it('goto + read: text and labelled interactive elements', async () => {
    const g = await act({ action: 'goto', url: `${siteUrl}/` });
    expect(g).toMatchObject({ ok: true, url: `${siteUrl}/`, title: 'Page de test' });

    const health = (await (await fetch(`${base}/health`, { headers: auth })).json()) as { browser: boolean; url: string };
    expect(health).toMatchObject({ browser: true, url: `${siteUrl}/` });

    const r = await act({ action: 'read' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Bonjour Ant');
    expect(r.text).not.toContain('Invisible');
    expect(r.elements).toEqual([
      { ref: 'e1', role: 'textbox', name: 'Recherche' },
      { ref: 'e2', role: 'textbox', name: 'Mot de passe' },
      { ref: 'e3', role: 'button', name: 'Valider' },
      { ref: 'e4', role: 'combobox', name: 'Couleur' },
      { ref: 'e5', role: 'tab', name: 'Onglet 1' },
      { ref: 'e6', role: 'link', name: 'Page suivante' },
    ]);
  });

  it('type + click by ref, select, press, scroll, screenshot', async () => {
    expect((await act({ action: 'type', ref: 'e1', text: 'chats' })).ok).toBe(true);
    expect((await act({ action: 'click', ref: 'e3' })).ok).toBe(true);
    const after = await act({ action: 'read' });
    expect(after.text).toContain('Résultat : chats');

    expect((await act({ action: 'select', ref: 'e4', text: 'Bleu' })).ok).toBe(true);
    expect((await act({ action: 'select', selector: '#color', text: 'r' })).ok).toBe(true);
    const badOption = await act({ action: 'select', selector: '#color', text: 'Vert' });
    expect(badOption.ok).toBe(false);
    expect(badOption.error).toMatch(/introuvable/);

    expect((await act({ action: 'press', selector: '#q', key: 'End' })).ok).toBe(true);
    expect((await act({ action: 'scroll', direction: 'down' })).ok).toBe(true);

    const shot = await act({ action: 'screenshot' });
    expect(shot.ok).toBe(true);
    const png = Buffer.from(shot.screenshotPng!, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');

    const missing = await act({ action: 'click', ref: 'e999' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/Aucun élément/);
  });

  it('inspect labels the target, outlines it only during the screenshot', async () => {
    await act({ action: 'read' });
    const r = await post<BrowserTargetInfo & { screenshotPng?: string }>(base, '/browser/inspect', { ref: 'e3' });
    expect(r.status).toBe(200);
    expect(r.body.elementLabel).toBe('Valider');
    expect(r.body.title).toBe('Page de test');
    expect(r.body.screenshotPng?.length).toBeGreaterThan(100);
    // Mark and outline are gone afterwards.
    expect((await act({ action: 'click', selector: '[data-ant-inspect]' })).ok).toBe(false);
    expect((await act({ action: 'click', selector: '#go[style*="outline"]' })).ok).toBe(false);
    const unknown = await post<BrowserTargetInfo>(base, '/browser/inspect', { selector: '#nope' });
    expect(unknown.body.elementLabel).toBeNull();
    const none = await post(base, '/browser/inspect', {});
    expect(none.status).toBe(400);
  });

  it('click on a link navigates; back returns', async () => {
    await act({ action: 'read' });
    const nav = await act({ action: 'click', selector: 'a' });
    expect(nav).toMatchObject({ ok: true, url: `${siteUrl}/second`, title: 'Deuxième' });
    const back = await act({ action: 'back' });
    expect(back).toMatchObject({ ok: true, url: `${siteUrl}/`, title: 'Page de test' });
  });

  it('relaunches the browser after it was closed', async () => {
    await browser.close();
    const h = (await (await fetch(`${base}/health`, { headers: auth })).json()) as { browser: boolean };
    expect(h.browser).toBe(false);
    const g = await act({ action: 'goto', url: `${siteUrl}/second` });
    expect(g).toMatchObject({ ok: true, title: 'Deuxième' });
  });
});
