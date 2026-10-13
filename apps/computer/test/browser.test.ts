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

/** A feed with several same-label buttons; « Nouveau » prepends a row, « Dupliquer » clones Bob's row. */
const FEED = `<!doctype html><html><head><title>Fil</title></head><body>
<ul id="feed">
<li>Alice <button onclick="follow('Alice')">Suivre</button></li>
<li id="bob">Bob <button onclick="follow('Bob')">Suivre</button></li>
<li>Carol <button onclick="follow('Carol')">Suivre</button></li>
</ul>
<button id="add" onclick="addRow()">Nouveau</button>
<button id="dup" onclick="dupBob()">Dupliquer</button>
<p id="out"></p>
<script>
function follow(n) { document.getElementById('out').textContent += 'Suivi : ' + n + ';'; }
function addRow() {
  var li = document.createElement('li');
  li.innerHTML = 'Mallory <button onclick="follow(\\'Mallory\\')">Suivre</button>';
  var feed = document.getElementById('feed');
  feed.insertBefore(li, feed.firstChild);
}
function dupBob() { var li = document.getElementById('bob'); li.parentNode.appendChild(li.cloneNode(true)); }
</script>
</body></html>`;

/** Pins planted by the page itself: a short non-UUID and a 100 kB string. */
const PLANTED = `<!doctype html><html><head><title>Épingles plantées</title></head><body>
<button id="short" data-ant-pin="x" onclick="hit('court')">Court</button>
<button id="long" onclick="hit('long')">Long</button>
<p id="out"></p>
<script>
document.getElementById('long').setAttribute('data-ant-pin', 'a'.repeat(100000));
function hit(n) { document.getElementById('out').textContent += 'Clic : ' + n + ';'; }
</script>
</body></html>`;

/** A planted pin plus a RegExp that accepts anything: the page lies to the in-page check. */
const TAMPERED = `<!doctype html><html><head><title>Piège</title></head><body>
<button id="trap" data-ant-pin="x">Piégé</button>
<script>window.RegExp = function () { return { test: function () { return true; } }; };</script>
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
      if (req.url === '/webdriver') {
        res.end('<title>wd</title><p id="wd"></p><script>document.getElementById("wd").textContent = "webdriver=" + navigator.webdriver + " lang=" + navigator.language;</script>');
        return;
      }
      if (req.url === '/feed') {
        res.end(FEED);
        return;
      }
      if (req.url === '/planted' || req.url === '/tampered') {
        res.end(req.url === '/planted' ? PLANTED : TAMPERED);
        return;
      }
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

  it('looks like a normal browser to websites (no webdriver flag, French locale)', async () => {
    await act({ action: 'goto', url: `${siteUrl}/webdriver` });
    const r = await act({ action: 'read' });
    expect(r.text).toContain('webdriver=false');
    expect(r.text).toContain('lang=fr-CH');
  });

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

  it('inspect pins the exact element: the approved click cannot land on another one after a new read', async () => {
    type Inspected = BrowserTargetInfo & { screenshotPng?: string };
    await act({ action: 'goto', url: `${siteUrl}/feed` });
    const before = await act({ action: 'read' });
    expect(before.elements?.slice(0, 3)).toEqual([
      { ref: 'e1', role: 'button', name: 'Suivre' },
      { ref: 'e2', role: 'button', name: 'Suivre' },
      { ref: 'e3', role: 'button', name: 'Suivre' },
    ]);
    // Approval card for « click e2 » (Bob's button).
    const card = await post<Inspected>(base, '/browser/inspect', { ref: 'e2' });
    expect(card.status).toBe(200);
    expect(card.body.elementLabel).toBe('Suivre');
    const pin = card.body.pin!;
    expect(pin).toMatch(/^[0-9a-f-]{36}$/);
    // A second card on the same node reuses its pin (both approvals stay valid).
    expect((await post<Inspected>(base, '/browser/inspect', { ref: 'e2' })).body.pin).toBe(pin);

    // While the approval waits, the feed changes and another run reads the page: e2 is now Alice.
    expect((await act({ action: 'click', selector: '#add' })).ok).toBe(true);
    const after = await act({ action: 'read' });
    expect(after.elements?.slice(0, 4).map((e) => e.name)).toEqual(['Suivre', 'Suivre', 'Suivre', 'Suivre']);

    // Execution-time check by pin, then the click itself: Bob, and only Bob.
    const recheck = await post<Inspected>(base, '/browser/inspect', { pin });
    expect(recheck.body).toMatchObject({ elementLabel: 'Suivre', pin });
    expect((await act({ action: 'click', pin })).ok).toBe(true);
    expect((await act({ action: 'read' })).text).toContain('Suivi : Bob;');
    expect((await act({ action: 'read' })).text).not.toMatch(/Suivi : (Alice|Mallory|Carol)/);

    // Never a guess: a pin matching several nodes, or none, is refused.
    expect((await act({ action: 'click', selector: '#dup' })).ok).toBe(true);
    const ambiguous = await act({ action: 'click', pin });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/ambigu/);
    expect((await post<Inspected>(base, '/browser/inspect', { pin })).body.elementLabel).toBeNull();

    await act({ action: 'goto', url: `${siteUrl}/feed` }); // reload: the pinned node is gone
    const gone = await act({ action: 'click', pin });
    expect(gone.ok).toBe(false);
    expect(gone.error).toMatch(/n'est plus sur la page/);
    const goneCard = await post<Inspected>(base, '/browser/inspect', { pin });
    expect(goneCard.body.elementLabel).toBeNull();
    expect(goneCard.body.pin).toBeUndefined();
    expect((await act({ action: 'press', pin, key: 'Enter' })).ok).toBe(false);

    const invalid = await act({ action: 'click', pin: 'e2' });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/Épingle d'élément invalide/);
    expect((await post(base, '/browser/inspect', { pin: 'e2' })).status).toBe(400);
    await act({ action: 'goto', url: `${siteUrl}/` });
  });

  it('inspect never hands out a pin planted by the page', async () => {
    type Inspected = BrowserTargetInfo & { screenshotPng?: string };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    await act({ action: 'goto', url: `${siteUrl}/planted` });
    for (const selector of ['#short', '#long']) {
      const card = await post<Inspected>(base, '/browser/inspect', { selector });
      expect(card.status).toBe(200);
      expect(card.body.elementLabel).toBe(selector === '#short' ? 'Court' : 'Long');
      const pin = card.body.pin!;
      expect(pin).toMatch(uuid);
      // The fresh pin replaced the planted value on that node: it is kept and the approval works.
      expect((await post<Inspected>(base, '/browser/inspect', { selector })).body.pin).toBe(pin);
      expect((await act({ action: 'click', pin })).ok).toBe(true);
    }
    expect((await act({ action: 'read' })).text).toContain('Clic : court;Clic : long;');

    // Builtins tampered with by the page: still no pin other than a UUID.
    await act({ action: 'goto', url: `${siteUrl}/tampered` });
    const trapped = await post<Inspected>(base, '/browser/inspect', { selector: '#trap' });
    expect(trapped.status).toBe(200);
    expect(trapped.body.elementLabel).toBe('Piégé');
    expect(trapped.body.pin).toBeUndefined();
    await act({ action: 'goto', url: `${siteUrl}/` });
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
