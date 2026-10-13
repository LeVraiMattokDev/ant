import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authenticator } from 'otplib';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { WebConfig } from '../src/config';
import { approvals, jobs, runs } from '../src/db/schema';
import { createApproval } from '../src/services/approvals';
import { PushSender } from '../src/services/push';
import { buildApp } from '../src/web/app';
import { createTestDb, databaseAvailable, stubComputer, type TestDb } from './helpers';

const hasDb = await databaseAvailable();
const ORIGIN = 'https://ant.test';

function webConfig(url: string): WebConfig {
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
  };
}

describe.skipIf(!hasDb)('web API', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let cookie = '';
  let totpSecret = '';
  let recoveryCodes: string[] = [];

  const headers = (extra: Record<string, string> = {}) => ({ 'x-requested-with': 'ant', origin: ORIGIN, cookie, ...extra });
  const keepCookie = (res: LightMyRequestResponse) => {
    const set = res.cookies.find((c) => c.name === '__Host-ant_session');
    if (set) cookie = `__Host-ant_session=${set.value}`;
  };
  const post = async (url: string, payload: unknown, extra: Record<string, string> = {}) => {
    const res = await app.inject({ method: 'POST', url, payload: payload as object, headers: headers(extra) });
    keepCookie(res);
    return res;
  };
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  beforeAll(async () => {
    t = await createTestDb();
    const built = await buildApp(
      {
        ctx: t.ctx,
        cfg: webConfig(t.url),
        session: { secureCookies: true, idleHours: 12, absoluteDays: 30 },
        push: new PushSender(t.ctx, { subject: 'mailto:x@example.com' }),
        computer: stubComputer(),
        setupToken: { value: 'setup-token-for-tests' },
        rpID: 'ant.test',
      },
      {
        serveUi: false,
        rpc: {
          parse: async () => ({ cron: '0 8 * * 1', timezone: 'Europe/Zurich', instruction: 'Point', urgent: false, description: 'Chaque lundi à 08:00', nextRuns: [] }),
        },
      },
    );
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('requires setup and protects every route', async () => {
    const state = (await get('/api/auth/state')).json();
    expect(state.setupRequired).toBe(true);
    expect((await get('/api/bots')).statusCode).toBe(401);
    expect((await get('/api/quota')).statusCode).toBe(401);
    expect((await get('/api/audit')).statusCode).toBe(401);
  });

  it('rejects a wrong setup token and a weak password', async () => {
    expect((await post('/api/auth/setup', { setupToken: 'nope', password: 'a-very-long-password-123' })).statusCode).toBe(403);
    const weak = await post('/api/auth/setup', { setupToken: 'setup-token-for-tests', password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().message).toContain('14');
  });

  it('completes setup with TOTP enrolment and recovery codes', async () => {
    const res = await post('/api/auth/setup', { setupToken: 'setup-token-for-tests', password: 'correct horse battery staple 42' });
    expect(res.statusCode).toBe(200);
    totpSecret = res.json().totpSecret;
    expect(res.json().totpUri).toContain('otpauth://');
    // Enrolment session cannot reach the API yet.
    expect((await get('/api/bots')).statusCode).toBe(401);
    expect((await post('/api/auth/setup/totp', { code: '000000' })).statusCode).toBe(400);
    const ok = await post('/api/auth/setup/totp', { code: authenticator.generate(totpSecret) });
    expect(ok.statusCode).toBe(200);
    recoveryCodes = ok.json().recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    expect((await get('/api/bots')).statusCode).toBe(200);
    expect((await get('/api/auth/state')).json()).toMatchObject({ setupRequired: false, authenticated: true });
    // Setup cannot be redone.
    expect((await post('/api/auth/setup', { setupToken: 'setup-token-for-tests', password: 'another long password 99' })).statusCode).toBe(409);
  });

  it('enforces the CSRF header and origin on mutations', async () => {
    const noHeader = await app.inject({ method: 'POST', url: '/api/bots', payload: { name: 'X', role: 'x' }, headers: { cookie, origin: ORIGIN } });
    expect(noHeader.statusCode).toBe(403);
    const badOrigin = await app.inject({ method: 'POST', url: '/api/bots', payload: { name: 'X', role: 'x' }, headers: { cookie, origin: 'https://evil.example', 'x-requested-with': 'ant' } });
    expect(badOrigin.statusCode).toBe(403);
  });

  it('applies auth and CSRF to percent-encoded /api paths', async () => {
    for (const url of ['/%61pi/bots', '/%61%70%69/settings', '/%61pi/auth/sessions', '/%61pi/computer/terminal', '/%61pi/audit']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    const reg = await app.inject({ method: 'POST', url: '/%61pi/auth/passkey/register/options', payload: {}, headers: { 'x-requested-with': 'ant', origin: ORIGIN } });
    expect(reg.statusCode).toBe(401);
    const csrf = await app.inject({ method: 'POST', url: '/%61pi/bots', payload: { name: 'X', role: 'x' }, headers: { cookie, origin: 'https://evil.example' } });
    expect(csrf.statusCode).toBe(403);
  });

  it('creates a bot with its DM and dispatches a message to it', async () => {
    const bot = (await post('/api/bots', { name: 'Chef de cabinet', role: 'Assistant principal', avatar: '🧭' })).json();
    expect(bot.slug).toBe('chef-de-cabinet');
    expect(bot.model).toBe('claude-sonnet-5-5');
    expect(bot.effort).toBe('medium');
    const channels = (await get('/api/channels')).json();
    expect(channels.find((c: { id: string }) => c.id === bot.dmChannelId)?.kind).toBe('dm');
    const sent = (await post(`/api/channels/${bot.dmChannelId}/messages`, { content: 'Bonjour' })).json();
    expect(sent.runs).toHaveLength(1);
    const job = await t.ctx.db.query.jobs.findFirst({ where: eq(jobs.kind, 'bot.run') });
    expect(job?.lane).toBe(`run:${bot.id}:${bot.dmChannelId}`);
    const list = (await get(`/api/channels/${bot.dmChannelId}/messages`)).json();
    expect(list[0].content).toBe('Bonjour');
    // Thread replies are counted on the root message.
    await post(`/api/channels/${bot.dmChannelId}/messages`, { content: 'Une précision', threadRootId: list[0].id });
    const withReply = (await get(`/api/channels/${bot.dmChannelId}/messages`)).json();
    expect(withReply[0].replyCount).toBe(1);
    expect(withReply[0].lastReplyAt).toBeTruthy();
    const preview = ((await get('/api/channels')).json() as { id: string; lastMessage: { content: string } | null }[]).find((c) => c.id === bot.dmChannelId);
    expect(preview?.lastMessage?.content).toBe('Bonjour');
    const search = (await get('/api/search?q=bonjour')).json();
    expect(search).toHaveLength(1);
  });

  it('routes group messages to mentioned bots', async () => {
    const dev = (await post('/api/bots', { name: 'Dev', role: 'Développement' })).json();
    const all = (await get('/api/bots')).json() as { id: string; slug: string }[];
    const chef = all.find((b) => b.slug === 'chef-de-cabinet')!;
    const channel = (await post('/api/channels', { name: 'projet', botIds: [chef.id, dev.id] })).json();
    const res = (await post(`/api/channels/${channel.id}/messages`, { content: '@dev regarde ça' })).json();
    expect(res.runs.map((r: { botId: string }) => r.botId)).toEqual([dev.id]);
    const lead = (await post(`/api/channels/${channel.id}/messages`, { content: 'sans mention' })).json();
    expect(lead.runs.map((r: { botId: string }) => r.botId)).toEqual([chef.id]);
  });

  it('validates settings and exposes quota status', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiDailyCapUsd: 1000 }, headers: headers() })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiDailyCapUsd: 5 }, headers: headers() });
    expect(ok.json().apiDailyCapUsd).toBe(5);
    const quota = (await get('/api/quota')).json();
    expect(quota.mode).toBe('hybrid_safe');
    expect(quota.api.dailyCapUsd).toBe(5);
  });

  it('decides approvals once: approve queues the exact execution, reject wakes the bot', async () => {
    const bot = ((await get('/api/bots')).json() as { id: string; dmChannelId: string }[])[0]!;
    const a1 = await createApproval(t.ctx, { runId: null, botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, category: 'commande_risquee', tool: 'computer_exec', summary: 'git push', payload: { command: 'git push' }, expiryHours: 1 });
    const approve = await post(`/api/approvals/${a1.id}/decide`, { decision: 'approve' });
    expect(approve.json().status).toBe('approved');
    expect((await post(`/api/approvals/${a1.id}/decide`, { decision: 'reject' })).statusCode).toBe(409);
    expect(await t.ctx.db.query.jobs.findFirst({ where: eq(jobs.dedupeKey, `approval:${a1.id}`) })).toBeTruthy();

    const a2 = await createApproval(t.ctx, { runId: null, botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, category: 'publication', tool: 'request_approval', summary: 'post', payload: {}, expiryHours: 1 });
    await post(`/api/approvals/${a2.id}/decide`, { decision: 'reject', comment: 'pas maintenant' });
    const run = await t.ctx.db.query.runs.findFirst({ where: eq(runs.trigger, 'approval') });
    expect(run?.prompt).toContain('REFUSÉ');
    expect(run?.prompt).toContain('pas maintenant');
    const rows = await t.ctx.db.select().from(approvals);
    expect(rows.find((r) => r.id === a2.id)?.status).toBe('rejected');
  });

  it('parses, previews and creates routines', async () => {
    const bot = ((await get('/api/bots')).json() as { id: string }[])[0]!;
    const draft = (await post('/api/routines/parse', { text: 'chaque lundi à 8h, un point', botId: bot.id })).json();
    expect(draft.cron).toBe('0 8 * * 1');
    const preview = (await post('/api/routines/preview', { cron: '0 8 * * 1' })).json();
    expect(preview.description).toBe('Chaque lundi à 08:00');
    expect(preview.nextRuns).toHaveLength(3);
    expect((await post('/api/routines/preview', { cron: '* * * * *' })).statusCode).toBe(400);
    const routine = (await post('/api/routines', { botId: bot.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Fais le point' })).json();
    expect(routine.enabled).toBe(true);
    expect(routine.nextRuns).toHaveLength(3);
  });

  it('audits and exports the log', async () => {
    const entries = (await get('/api/audit?limit=500')).json() as { event: string }[];
    expect(entries.some((e) => e.event === 'auth.setup.complete')).toBe(true);
    const csv = await get('/api/audit/export.csv');
    expect(csv.headers['content-type']).toContain('text/csv');
  });

  it('logs out, then throttles password guessing', async () => {
    await post('/api/auth/logout', {});
    expect((await get('/api/bots')).statusCode).toBe(401);
    cookie = '';
    // Earlier failures from this IP (bad setup token, wrong TOTP) count too: 5 failures in 15 min max.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post('/api/auth/login', { password: 'wrong' })).statusCode);
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.slice(3)).toEqual([429, 429]);
    const blocked = await post('/api/auth/login', { password: 'correct horse battery staple 42' });
    expect(blocked.statusCode).toBe(429);
  });

  it('logs in with password + recovery code (single use) from another IP', async () => {
    const ip = { 'x-forwarded-for': '10.0.0.9' };
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'correct horse battery staple 42' }, headers: headers(ip), remoteAddress: '10.0.0.9' });
    expect(login.statusCode).toBe(200);
    keepCookie(login);
    expect((await get('/api/bots')).statusCode).toBe(401);
    const second = await app.inject({ method: 'POST', url: '/api/auth/login/second-factor', payload: { recoveryCode: recoveryCodes[0] }, headers: headers(), remoteAddress: '10.0.0.9' });
    expect(second.statusCode).toBe(200);
    keepCookie(second);
    expect((await get('/api/bots')).statusCode).toBe(200);

    // Reusing the same recovery code fails.
    const again = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'correct horse battery staple 42' }, headers: headers(), remoteAddress: '10.0.0.10' });
    keepCookie(again);
    const reuse = await app.inject({ method: 'POST', url: '/api/auth/login/second-factor', payload: { recoveryCode: recoveryCodes[0] }, headers: headers(), remoteAddress: '10.0.0.10' });
    expect(reuse.statusCode).toBe(401);
  });
});
