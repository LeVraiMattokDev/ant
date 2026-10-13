import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { isAuthorized } from '../src/auth';
import { ConfigError, loadConfig } from '../src/config';
import { createComputerServer } from '../src/server';
import { auth, close, listen, post, tempDir, testConfig, TOKEN } from './helpers';

describe('isAuthorized', () => {
  it('accepts exactly the bearer token', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
    expect(isAuthorized('', TOKEN)).toBe(false);
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false);
    expect(isAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
    expect(isAuthorized('Bearer ', TOKEN)).toBe(false);
    expect(isAuthorized([`Bearer ${TOKEN}`], TOKEN)).toBe(false);
  });
});

describe('loadConfig', () => {
  it('refuses to start without a long enough token', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ COMPUTER_RPC_TOKEN: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ COMPUTER_RPC_TOKEN: TOKEN, PORT: 'abc' })).toThrow(ConfigError);
  });
  it('applies defaults', () => {
    const cfg = loadConfig({ COMPUTER_RPC_TOKEN: TOKEN });
    expect(cfg).toMatchObject({
      port: 7000,
      workspaceRoot: '/workspace',
      browserProfileDir: '/home/agent/.ant-browser',
      display: ':99',
      vncSocket: '/tmp/.ant-vnc/vnc.sock',
      headless: false,
      maxOutputBytes: 100_000,
    });
    expect(loadConfig({ COMPUTER_RPC_TOKEN: TOKEN, VNC_SOCKET: ' /run/ant/vnc.sock ' }).vncSocket).toBe('/run/ant/vnc.sock');
  });
});

describe('HTTP + WebSocket auth', () => {
  let server: Server;
  let base: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    server = createComputerServer({ cfg: testConfig(t.dir) });
    base = await listen(server);
  });
  afterAll(async () => {
    await close(server);
    await cleanup();
  });

  it('/livez is open and says nothing', async () => {
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('every route requires the token (401 JSON in French)', async () => {
    for (const [method, route] of [
      ['GET', '/health'],
      ['POST', '/exec'],
      ['POST', '/files/read'],
      ['GET', '/files/download?path=a'],
      ['POST', '/browser'],
      ['GET', '/nope'],
    ] as const) {
      const res = await fetch(`${base}${route}`, { method, headers: { authorization: 'Bearer wrong-token-wrong-token-wrong' } });
      expect(res.status, route).toBe(401);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('unauthorized');
      expect(body.message).toMatch(/Jeton/);
    }
    const noHeader = await post(base, '/exec', { command: 'id' }, {});
    expect(noHeader.status).toBe(401);
  });

  it('accepts the token, 404 on unknown routes, 405 on wrong method', async () => {
    const health = await fetch(`${base}/health`, { headers: auth });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, display: true, browser: false, url: null });
    expect((await fetch(`${base}/nope`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/exec`, { headers: auth })).status).toBe(405);
  });

  it('rejects invalid JSON and invalid bodies with 400', async () => {
    const res = await fetch(`${base}/exec`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/JSON invalide/);
    const bad = await post<{ error: string; message: string }>(base, '/exec', { command: 42 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/command/);
  });

  it('rejects bodies over 5 MB with 413', async () => {
    const res = await fetch(`${base}/files/write`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'big.txt', content: 'x'.repeat(5 * 1024 * 1024 + 10) }),
    });
    expect(res.status).toBe(413);
  });

  it('WebSocket upgrades require the token', async () => {
    const wsBase = base.replace('http', 'ws');
    for (const route of ['/vnc', '/terminal']) {
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${wsBase}${route}`);
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => resolve(101));
        ws.on('error', () => undefined);
      });
      expect(status, route).toBe(401);
    }
    const unknown = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${wsBase}/other`, { headers: auth });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => undefined);
    });
    expect(unknown).toBe(404);
  });
});
