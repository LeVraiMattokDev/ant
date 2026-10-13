import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { authenticator } from 'otplib';
import WebSocket, { WebSocketServer } from 'ws';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadWebConfig, type WebConfig } from '../src/config';
import { auditLog, authSessions, loginAttempts, webauthnCredentials } from '../src/db/schema';
import { randomToken, sha256 } from '../src/lib/crypto';
import { PushSender } from '../src/services/push';
import { buildApp } from '../src/web/app';
import type { RealtimeHub } from '../src/web/ws';
import { createTestDb, databaseAvailable, stubComputer, type TestDb } from './helpers';

const hasDb = await databaseAvailable();
const ORIGIN = 'https://ant.test';
const PASSWORD = 'correct horse battery staple 42';
const SESSION_COOKIE = '__Host-ant_session';

function webConfig(url: string, overrides: Partial<WebConfig> = {}): WebConfig {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: url,
    MIGRATIONS_DIR: '',
    COMPUTER_URL: 'http://computer.test:7000',
    COMPUTER_RPC_TOKEN: 'test-computer-token-0123456789',
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: 'mailto:test@example.com',
    PUBLIC_ORIGIN: ORIGIN,
    PORT: 0,
    HOST: '127.0.0.1',
    ENCRYPTION_KEY: 'test-encryption-key-0123456789-abcdef',
    SETUP_TOKEN: 'setup-token-for-tests',
    UI_DIST: '/nonexistent',
    TRUST_PROXY: 'false',
    SESSION_IDLE_HOURS: 12,
    SESSION_ABSOLUTE_DAYS: 30,
    ...overrides,
  };
}

/** TOTP code for the time step `offset` steps after `base` (window 1 accepts the next step). */
function totpAt(secret: string, base: number, offset = 0): string {
  const otp = authenticator.clone();
  otp.options = { epoch: base + offset * 30_000 };
  return otp.generate(secret);
}

interface Harness {
  t: TestDb;
  app: FastifyInstance;
  hub: RealtimeHub;
  close(): Promise<void>;
}

async function harness(opts: { computer?: ReturnType<typeof stubComputer>; cfg?: Partial<WebConfig> } = {}): Promise<Harness> {
  const t = await createTestDb();
  const built = await buildApp(
    {
      ctx: t.ctx,
      cfg: webConfig(t.url, opts.cfg),
      session: { secureCookies: true, idleHours: 12, absoluteDays: 30 },
      push: new PushSender(t.ctx, { subject: 'mailto:x@example.com' }),
      computer: opts.computer ?? stubComputer(),
      setupToken: { value: 'setup-token-for-tests' },
      rpID: 'ant.test',
    },
    { serveUi: false, rpc: { parse: async () => ({ cron: '0 8 * * 1', timezone: 'Europe/Zurich', instruction: 'x', urgent: false, description: 'x', nextRuns: [] }) } },
  );
  await built.app.ready();
  return {
    t,
    app: built.app,
    hub: built.hub,
    async close() {
      await built.app.close();
      await t.drop();
    },
  };
}

const sessionCookie = (res: LightMyRequestResponse): string => {
  const set = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return set ? `${SESSION_COOKIE}=${set.value}` : '';
};

/** A full session written straight into the database (for socket tests). */
async function fullSession(t: TestDb, patch: Partial<typeof authSessions.$inferInsert> = {}): Promise<{ id: string; cookie: string }> {
  const token = randomToken(32);
  const id = sha256(token);
  await t.ctx.db.insert(authSessions).values({ id, stage: 'full', expiresAt: new Date(Date.now() + 86_400_000), ip: '127.0.0.1', userAgent: 'test', ...patch });
  return { id, cookie: `${SESSION_COOKIE}=${token}` };
}

/** Opens a client socket and records its close code from the start (closing can beat any later listener). */
function connect(url: string, cookie: string): { ws: WebSocket; closed: Promise<number> } {
  const ws = new WebSocket(url, { headers: { cookie, origin: ORIGIN } });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  return { ws, closed };
}

function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('socket still open')), ms))]);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe.skipIf(!hasDb)('web security: credentials and sessions', () => {
  let h: Harness;
  let upstream: WebSocketServer;
  const upstreamClosed: Promise<void>[] = [];
  let base = 0;
  let totpSecret = '';
  let recoveryCodes: string[] = [];
  let cookie = '';
  let password = PASSWORD;

  const inject = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, extra: { cookie?: string; ip?: string; headers?: Record<string, string> } = {}) => {
    const res = await h.app.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as object } : {}),
      remoteAddress: extra.ip ?? '127.0.0.1',
      headers: { 'x-requested-with': 'ant', origin: ORIGIN, cookie: extra.cookie ?? cookie, ...extra.headers },
    });
    return res;
  };

  /** Password + second factor; returns the full session cookie. */
  const login = async (second: { code?: string; recoveryCode?: string }, ip: string, userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/130.0'): Promise<{ status: number; cookie: string }> => {
    const first = await inject('POST', '/api/auth/login', { password }, { cookie: '', ip, headers: { 'user-agent': userAgent } });
    expect(first.statusCode).toBe(200);
    const res = await inject('POST', '/api/auth/login/second-factor', second, { cookie: sessionCookie(first), ip, headers: { 'user-agent': userAgent } });
    return { status: res.statusCode, cookie: sessionCookie(res) };
  };

  beforeAll(async () => {
    // Stand-in for the computer service: echoes terminal input and records when the bridge hangs up.
    upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    upstream.on('connection', (ws) => {
      upstreamClosed.push(new Promise((resolve) => ws.once('close', () => resolve())));
      ws.on('message', (data) => ws.send(data));
    });
    await new Promise<void>((resolve) => upstream.once('listening', () => resolve()));
    const port = (upstream.address() as { port: number }).port;
    h = await harness({ computer: stubComputer({ wsUrl: (path: string) => `ws://127.0.0.1:${port}${path}` }) });

    base = Date.now();
    const setup = await inject('POST', '/api/auth/setup', { setupToken: 'setup-token-for-tests', password: PASSWORD }, { cookie: '' });
    expect(setup.statusCode).toBe(200);
    totpSecret = setup.json().totpSecret;
    const enrol = await inject('POST', '/api/auth/setup/totp', { code: totpAt(totpSecret, base) }, { cookie: sessionCookie(setup) });
    expect(enrol.statusCode).toBe(200);
    recoveryCodes = enrol.json().recoveryCodes;
    cookie = sessionCookie(enrol);
  });

  afterAll(async () => {
    await h?.close();
    await new Promise((resolve) => upstream?.close(resolve));
  });

  it('refuses a TOTP code a second time, including the enrolment code', async () => {
    // The code used for enrolment cannot open a session.
    expect((await login({ code: totpAt(totpSecret, base) }, '10.0.1.1')).status).toBe(401);
    // The next code works once, then is refused (RFC 6238 §5.2).
    const next = totpAt(totpSecret, base, 1);
    expect((await login({ code: next }, '10.0.1.1')).status).toBe(200);
    expect((await login({ code: next }, '10.0.1.2')).status).toBe(401);
  });

  it('spends a recovery code once, even with parallel requests', async () => {
    const ips = ['10.0.2.1', '10.0.2.2', '10.0.2.3', '10.0.2.4'];
    const firsts = await Promise.all(ips.map((ip) => inject('POST', '/api/auth/login', { password }, { cookie: '', ip })));
    const mfa = firsts.map(sessionCookie);
    const same = await Promise.all([0, 1].map((i) => inject('POST', '/api/auth/login/second-factor', { recoveryCode: recoveryCodes[1] }, { cookie: mfa[i], ip: ips[i] })));
    expect(same.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    // Two different codes at once: both work, and neither comes back to life afterwards.
    const diff = await Promise.all([2, 3].map((i) => inject('POST', '/api/auth/login/second-factor', { recoveryCode: recoveryCodes[i] }, { cookie: mfa[i], ip: ips[i] })));
    expect(diff.map((r) => r.statusCode)).toEqual([200, 200]);
    for (const code of [recoveryCodes[1], recoveryCodes[2], recoveryCodes[3]]) {
      expect((await login({ recoveryCode: code }, '10.0.2.9')).status).toBe(401);
    }
  });

  it('asks for the password before adding a passkey', async () => {
    expect((await inject('POST', '/api/auth/passkey/register/options', {})).statusCode).toBe(400);
    expect((await inject('POST', '/api/auth/passkey/register/options', { password: 'not the password' })).statusCode).toBe(401);
    const ok = await inject('POST', '/api/auth/passkey/register/options', { password });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().challenge).toBeTruthy();
  });

  it('can drop every passkey when the password changes', async () => {
    await h.t.ctx.db.insert(webauthnCredentials).values({ credentialId: 'planted', publicKey: 'x', name: 'Clé de l’intrus' });
    const res = await inject('POST', '/api/auth/password', { current: password, next: 'another long passphrase 2026', revokePasskeys: true });
    expect(res.statusCode).toBe(200);
    password = 'another long passphrase 2026';
    expect(await h.t.ctx.db.select().from(webauthnCredentials)).toHaveLength(0);
    const events = (await h.t.ctx.db.select().from(auditLog)).map((a) => a.event);
    expect(events).toContain('auth.passkey.revoke_all');
    // The current session survives.
    expect((await inject('GET', '/api/bots')).statusCode).toBe(200);
  });

  it('flags a login from a browser or network never seen before', async () => {
    const res = await login({ recoveryCode: recoveryCodes[4] }, '203.0.113.50', 'Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile');
    expect(res.status).toBe(200);
    const last = (await h.t.ctx.db.select().from(auditLog).where(eq(auditLog.event, 'auth.login'))).at(-1);
    expect(last?.detail).toMatchObject({ method: 'recovery_code', newDevice: true });
    // Same browser, same /24, newer browser version: known.
    const again = await login({ recoveryCode: recoveryCodes[5] }, '203.0.113.77', 'Mozilla/5.0 (Linux; Android 14) Chrome/130.1 Mobile');
    expect(again.status).toBe(200);
    const known = (await h.t.ctx.db.select().from(auditLog).where(eq(auditLog.event, 'auth.login'))).at(-1);
    expect(known?.detail).not.toHaveProperty('newDevice');
  });

  it('answers 400, not 500, for a malformed identifier', async () => {
    for (const [method, url] of [
      ['GET', '/api/channels/foo/messages'],
      ['PATCH', '/api/bots/foo'],
      ['GET', '/api/messages/foo/thread'],
      ['GET', '/api/runs?botId=foo'],
      ['DELETE', '/api/auth/passkeys/foo'],
    ] as const) {
      const res = await inject(method, url, method === 'PATCH' ? { name: 'x' } : undefined);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    }
  });

  it('shows what the service sees of the connection', async () => {
    const res = await inject('GET', '/api/system/network', undefined, { ip: '10.9.9.9', headers: { 'x-forwarded-for': '6.6.6.6' } });
    expect(res.json()).toEqual({ peerAddress: '10.9.9.9', clientIp: '10.9.9.9', forwardedFor: '6.6.6.6', trustProxy: 'false', trustAll: false });
  });

  it('closes the terminal bridge as soon as its session is revoked', async () => {
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const wsBase = address.replace('http:', 'ws:');
    const s = await fullSession(h.t);
    const before = upstreamClosed.length;
    const { ws: term, closed } = connect(`${wsBase}/api/computer/terminal`, s.cookie);
    await waitOpen(term);
    const echoed = new Promise<string>((resolve) => term.once('message', (d) => resolve(d.toString())));
    term.send('ls\n');
    expect(await echoed).toBe('ls\n');
    expect(upstreamClosed.length).toBe(before + 1);

    // Logout of that session (same path as a revocation from Settings or a password change elsewhere).
    const out = await inject('POST', '/api/auth/logout', {}, { cookie: s.cookie });
    expect(out.statusCode).toBe(200);
    expect(await within(closed)).toBe(4401);
    await upstreamClosed[before]; // the shell on the computer side is hung up too
  });

  it('closes realtime and VNC sockets at absolute or idle expiry', async () => {
    const wsBase = `ws://127.0.0.1:${(h.app.server.address() as { port: number }).port}`;
    const expiring = await fullSession(h.t);
    const idle = await fullSession(h.t);
    const fresh = await fullSession(h.t);
    const { ws: vnc, closed: vncClosed } = connect(`${wsBase}/api/computer/vnc`, expiring.cookie);
    const { ws: feed, closed: feedClosed } = connect(`${wsBase}/api/ws`, idle.cookie);
    const { ws: kept } = connect(`${wsBase}/api/ws`, fresh.cookie);
    await Promise.all([waitOpen(vnc), waitOpen(feed), waitOpen(kept)]);

    await h.t.ctx.db.update(authSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authSessions.id, expiring.id));
    await h.t.ctx.db.update(authSessions).set({ lastSeenAt: new Date(Date.now() - 13 * 3600_000) }).where(eq(authSessions.id, idle.id));
    expect(await h.hub.revalidateSessions()).toBe(2);
    expect(await within(vncClosed)).toBe(4401);
    expect(await within(feedClosed)).toBe(4401);
    // The idle session is revoked, as an HTTP request would have done.
    const idleRow = await h.t.ctx.db.query.authSessions.findFirst({ where: eq(authSessions.id, idle.id) });
    expect(idleRow?.revokedAt).toBeTruthy();
    expect(kept.readyState).toBe(WebSocket.OPEN);
    kept.close();
  });
});

describe.skipIf(!hasDb)('web security: login throttling', () => {
  let h: Harness;
  let cookie = '';
  const base = Date.now();

  const inject = (url: string, payload: unknown, ip: string, withCookie = '') =>
    h.app.inject({ method: 'POST', url, payload: payload as object, remoteAddress: ip, headers: { 'x-requested-with': 'ant', origin: ORIGIN, cookie: withCookie } });

  beforeAll(async () => {
    h = await harness();
    const setup = await inject('/api/auth/setup', { setupToken: 'setup-token-for-tests', password: PASSWORD }, '127.0.0.1');
    const enrol = await inject('/api/auth/setup/totp', { code: totpAt(setup.json().totpSecret, base) }, '127.0.0.1', sessionCookie(setup));
    expect(enrol.statusCode).toBe(200);
    cookie = sessionCookie(enrol);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('lets at most 5 wrong passwords through per IP, even sent in parallel', async () => {
    const res = await Promise.all(Array.from({ length: 20 }, () => inject('/api/auth/login', { password: 'wrong' }, '10.1.0.1')));
    const statuses = res.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    const failures = await h.t.ctx.db.select().from(loginAttempts).where(and(eq(loginAttempts.ip, '10.1.0.1'), eq(loginAttempts.success, false)));
    expect(failures).toHaveLength(5);
  });

  it('keeps the global lock to the step under attack, and warns once', async () => {
    // 50 wrong passwords in the last hour, spread over many addresses.
    await h.t.ctx.db.insert(loginAttempts).values(Array.from({ length: 50 }, (_, i) => ({ ip: `198.51.100.${i}`, kind: 'password', success: false })));
    const locked = await inject('/api/auth/login', { password: PASSWORD }, '10.2.0.1');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe('locked');
    expect((await inject('/api/auth/login', { password: PASSWORD }, '10.2.0.2')).json().error).toBe('locked');
    // Passkey login is not shut by it (no passkey here: 400, not 429).
    const passkey = await inject('/api/auth/passkey/login/options', {}, '10.2.0.3');
    expect(passkey.statusCode).toBe(400);
    expect(passkey.json().error).toBe('no_passkey');
    // A signed-in owner can still change the password.
    const change = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { current: PASSWORD, next: PASSWORD },
      remoteAddress: '10.2.0.4',
      headers: { 'x-requested-with': 'ant', origin: ORIGIN, cookie },
    });
    expect(change.statusCode).toBe(200);
    // One alert (and audit entry) per lock, not per refused attempt.
    const lockedEvents = await h.t.ctx.db.select().from(auditLog).where(eq(auditLog.event, 'auth.locked'));
    expect(lockedEvents).toHaveLength(1);
  });

  it('does not let a flood of wrong passwords lock the second factor', async () => {
    await h.t.ctx.db.delete(loginAttempts);
    const first = await inject('/api/auth/login', { password: PASSWORD }, '10.3.0.1');
    expect(first.statusCode).toBe(200);
    const mfa = sessionCookie(first);
    await h.t.ctx.db.insert(loginAttempts).values(Array.from({ length: 50 }, (_, i) => ({ ip: `198.51.100.${i}`, kind: 'password', success: false })));
    const wrong = await inject('/api/auth/login/second-factor', { code: '000000' }, '10.3.0.1', mfa);
    expect(wrong.statusCode).toBe(401);
    // Second-factor failures, on the other hand, do lock that step.
    await h.t.ctx.db.insert(loginAttempts).values(Array.from({ length: 50 }, (_, i) => ({ ip: `198.51.100.${i}`, kind: 'totp', success: false })));
    const locked = await inject('/api/auth/login/second-factor', { code: '000000' }, '10.3.0.1', mfa);
    expect(locked.json().error).toBe('locked');
  });
});

describe('web security: client address', () => {
  it('trusts only private proxies by default', () => {
    expect(loadWebConfig({ DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'k'.repeat(40) }).TRUST_PROXY).toBe('loopback,linklocal,uniquelocal');
  });

  it.skipIf(!hasDb)('takes the address NPM appended, not the one a client forged', async () => {
    const h = await harness({ cfg: { TRUST_PROXY: loadWebConfig({ DATABASE_URL: 'x', ENCRYPTION_KEY: 'k'.repeat(40) }).TRUST_PROXY } });
    try {
      const s = await fullSession(h.t);
      const ip = async (remoteAddress: string, xff: string) =>
        (await h.app.inject({ method: 'GET', url: '/api/system/network', remoteAddress, headers: { cookie: s.cookie, 'x-forwarded-for': xff } })).json().clientIp;
      // Through NPM (private address): the client's own forged entry is ignored, NPM's appended one wins.
      expect(await ip('192.168.1.5', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
      // A public peer cannot choose its address.
      expect(await ip('203.0.113.200', '6.6.6.6')).toBe('203.0.113.200');
    } finally {
      await h.close();
    }
  });
});
