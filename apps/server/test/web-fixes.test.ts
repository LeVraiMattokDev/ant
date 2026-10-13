import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authenticator } from 'otplib';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { WebConfig } from '../src/config';
import { agentSessions, auditLog, routines, runs } from '../src/db/schema';
import { audit } from '../src/lib/audit';
import { createApproval } from '../src/services/approvals';
import { createBot } from '../src/services/bots';
import { createRoutine, routineThreadKey } from '../src/services/routines';
import { PushSender } from '../src/services/push';
import { buildApp } from '../src/web/app';
import { ENCRYPTION_KEY_MISMATCH } from '../src/web/routes/auth';
import { ROUTINE_PARSE_TIMEOUT_MS } from '../src/web/routes/routines';
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

async function build(t: TestDb, cfg: Partial<WebConfig> = {}): Promise<FastifyInstance> {
  const built = await buildApp(
    {
      ctx: t.ctx,
      cfg: webConfig(t.url, cfg),
      session: { secureCookies: true, idleHours: 12, absoluteDays: 30 },
      push: new PushSender(t.ctx, { subject: 'mailto:x@example.com' }),
      computer: stubComputer(),
      setupToken: { value: 'setup-token-for-tests' },
      rpID: 'ant.test',
    },
    { serveUi: false, rpc: { parse: async () => ({ cron: '0 8 * * 1', timezone: 'Europe/Zurich', instruction: 'x', urgent: false, description: 'x', nextRuns: [] }) } },
  );
  await built.app.ready();
  return built.app;
}

const sessionCookie = (res: LightMyRequestResponse): string => {
  const set = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return set ? `${SESSION_COOKIE}=${set.value}` : '';
};

describe.skipIf(!hasDb)('web: follow-up fixes', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let cookie = '';
  let totpSecret = '';
  let base = 0;

  const inject = (target: FastifyInstance, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, as = cookie) =>
    target.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as object } : {}),
      headers: { 'x-requested-with': 'ant', origin: ORIGIN, cookie: as },
    });

  beforeAll(async () => {
    t = await createTestDb();
    app = await build(t);
    base = Date.now();
    const wrong = await inject(app, 'POST', '/api/auth/setup', { setupToken: 'not-the-token', password: PASSWORD }, '');
    expect(wrong.statusCode).toBe(403);
    // Points to where the token really is: the logs only print a generated one.
    expect(wrong.json().message).toContain('SETUP_TOKEN dans .env');
    const setup = await inject(app, 'POST', '/api/auth/setup', { setupToken: 'setup-token-for-tests', password: PASSWORD }, '');
    expect(setup.statusCode).toBe(200);
    totpSecret = setup.json().totpSecret;
    const otp = authenticator.clone();
    otp.options = { epoch: base };
    const enrol = await inject(app, 'POST', '/api/auth/setup/totp', { code: otp.generate(totpSecret) }, sessionCookie(setup));
    expect(enrol.statusCode).toBe(200);
    cookie = sessionCookie(enrol);
  });

  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('serves one approval by id, and 404 for an unknown or malformed id', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const approval = await createApproval(t.ctx, {
      runId: null,
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      category: 'commande_risquee',
      tool: 'computer_exec',
      title: 'git push',
      summary: 'git push origin main',
      payload: { command: 'git push origin main' },
      screenshotPng: null,
      expiryHours: 24,
    });
    const res = await inject(app, 'GET', `/api/approvals/${approval.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: approval.id, title: 'git push', status: 'pending', hasScreenshot: false });
    expect((await inject(app, 'GET', '/api/approvals/0190a0b2-0000-7000-8000-000000000000')).statusCode).toBe(404);
    const malformed = await inject(app, 'GET', '/api/approvals/pas-un-id');
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json().error).toBe('not_found');
  });

  it('filters the audit log on a bot together with its sub-agents', async () => {
    await audit(t.ctx.db, { actor: 'bot:veille', event: 'tool', tool: 'browser' });
    await audit(t.ctx.db, { actor: 'bot:veille/leger', event: 'subagent.start' });
    await audit(t.ctx.db, { actor: 'bot:veille2', event: 'tool' });
    const res = await inject(app, 'GET', `/api/audit?actor=${encodeURIComponent('bot:veille')}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().map((e: { actor: string }) => e.actor).sort()).toEqual(['bot:veille', 'bot:veille/leger']);
  });

  it('audits a push subscription once per device, not at each re-registration', async () => {
    const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } };
    for (let i = 0; i < 3; i++) expect((await inject(app, 'POST', '/api/push/subscribe', sub)).statusCode).toBe(200);
    expect(await t.ctx.db.select().from(auditLog).where(eq(auditLog.event, 'push.subscribe'))).toHaveLength(1);
  });

  it('runs a routine by hand in the routine’s own session', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'veille' });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Point', enabled: true }, 'Europe/Zurich');
    const res = await inject(app, 'POST', `/api/routines/${routine.id}/run`, {});
    expect(res.statusCode).toBe(200);
    const [run] = await t.ctx.db.select().from(runs).where(eq(runs.botId, bot.id));
    expect(run).toMatchObject({ threadKey: routineThreadKey(routine.id), trigger: 'routine', origin: 'user', channelId: bot.dmChannelId });
    expect(run!.payload.routineId).toBe(routine.id);
    expect(await t.ctx.db.select().from(agentSessions)).toHaveLength(0);
    await t.ctx.db.delete(routines).where(eq(routines.id, routine.id));
  });

  it('answers before the proxy gives up on a slow routine interpretation', () => {
    expect(ROUTINE_PARSE_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('says clearly when the TOTP secret was encrypted with another ENCRYPTION_KEY', async () => {
    // Same database, another key: what a backup restored without its .env looks like.
    const other = await build(t, { ENCRYPTION_KEY: 'another-encryption-key-9876543210-zyxwvu' });
    try {
      const first = await inject(other, 'POST', '/api/auth/login', { password: PASSWORD }, '');
      expect(first.statusCode).toBe(200);
      const otp = authenticator.clone();
      otp.options = { epoch: base + 60_000 };
      const res = await inject(other, 'POST', '/api/auth/login/second-factor', { code: otp.generate(totpSecret) }, sessionCookie(first));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'encryption_key_mismatch', message: ENCRYPTION_KEY_MISMATCH });
      expect(res.json().message).toContain('code de secours ou une passkey');
    } finally {
      await other.close();
    }
  });

  it('is healthy only while the database answers', async () => {
    const ok = await app.inject({ method: 'GET', url: '/healthz' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    const sql = t.ctx.sql;
    t.ctx.sql = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof sql;
    try {
      const down = await app.inject({ method: 'GET', url: '/healthz' });
      expect(down.statusCode).toBe(503);
      expect(down.json()).toMatchObject({ ok: false, error: 'database_unreachable' });
    } finally {
      t.ctx.sql = sql;
    }
  });
});
