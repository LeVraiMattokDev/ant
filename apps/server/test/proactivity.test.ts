import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agentSessions, budgetAlerts, bots, messages, nudges, routines, runModelUsage, runs } from '../src/db/schema';
import { updateSettings } from '../src/lib/settings';
import { createBot } from '../src/services/bots';
import { createMessage } from '../src/services/messages';
import { patchComputeState } from '../src/services/quota';
import { createRoutine } from '../src/services/routines';
import { requestRun } from '../src/services/runs';
import { checkBudgetAlerts } from '../src/worker/alerts';
import { runDigest } from '../src/worker/digest';
import { heartbeatDue, runHeartbeat } from '../src/worker/heartbeat';
import { rotateSession } from '../src/worker/rotate';
import { executeRun } from '../src/worker/runner';
import { schedulerTick } from '../src/worker/scheduler';
import { antTools } from '../src/worker/tools';
import { DEFAULT_BOT_PERMISSIONS, DEFAULT_SETTINGS, localDateKey, localMonthKey } from '@ant/shared';
import { createTestDb, databaseAvailable, fakeQuery, sdk, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();

describe.skipIf(!hasDb)('proactivity', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate runs, run_model_usage, messages, jobs, agent_sessions, approvals, nudges, routines, tasks, memory_items, channel_members, channels, bots, compute_state, budget_alerts, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
    // Quiet hours off so tests do not depend on the time of day.
    await updateSettings(t.ctx.db, { quietHours: null });
  });

  it('heartbeat: Haiku triage that finds nothing does not wake the bot model', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille technologique' });
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.result('', 0.0008, 'claude-haiku-5-5', 's', { creuser: false, sujets: [] });
    });
    const out = await runHeartbeat(workerDeps(t.ctx, query), bot.id);
    expect(out.status).toBe('nothing');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.model).toBe('claude-haiku-5-5');
    expect(calls[0]!.options.effort).toBe('low');
    expect(calls[0]!.options.tools).toEqual([]);
    // hybrid_safe: autonomous → API credits
    expect(calls[0]!.options.env?.ANTHROPIC_API_KEY).toBeDefined();
    expect(await t.ctx.db.select().from(runs)).toHaveLength(0);
    const usage = await t.ctx.db.select().from(runModelUsage);
    expect(usage[0]?.computeSource).toBe('api');
  });

  it('heartbeat: triage with topics queues a deep-dive run that can send deduplicated nudges', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'Coordination' });
    const triage = fakeQuery(async function* () {
      yield sdk.result('', 0.001, 'claude-haiku-5-5', 's', { creuser: true, sujets: [{ type: 'risque', pourquoi: 'Échéance du contrat dans 3 jours' }] });
    });
    const out = await runHeartbeat(workerDeps(t.ctx, triage.query), bot.id);
    expect(out.status).toBe('queued');
    const hbRun = await t.ctx.db.query.runs.findFirst({ where: eq(runs.trigger, 'heartbeat') });
    expect(hbRun?.priority).toBe('background');
    expect(hbRun?.origin).toBe('autonomous');
    expect(hbRun?.prompt).toContain('Échéance du contrat');
    expect((await t.ctx.db.query.bots.findFirst({ where: eq(bots.id, bot.id) }))?.lastHeartbeatAt).toBeTruthy();

    // The deep dive gets the nudge tool; nudges are deduplicated.
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query);
    const rc = {
      deps,
      settings: { ...DEFAULT_SETTINGS, quietHours: null },
      run: hbRun!,
      bot: (await t.ctx.db.query.bots.findFirst({ where: eq(bots.id, bot.id) }))!,
      permissions: DEFAULT_BOT_PERMISSIONS,
      channel: null,
      computeSource: 'api' as const,
      pendingApprovals: [],
      outputs: { attachments: [] },
      botsBySlug: new Map(),
      setActivity: async () => undefined,
    };
    const tools = antTools(rc);
    const nudge = tools.find((x) => x.name === 'nudge_create')!.handler as (a: Record<string, unknown>, e: unknown) => Promise<{ isError?: boolean }>;
    const first = await nudge({ kind: 'risque', title: 'Contrat à renouveler avant vendredi', content: 'Le contrat d’hébergement expire vendredi : je propose de préparer le renouvellement demain.' }, {});
    expect(first.isError).toBeFalsy();
    const dup = await nudge({ kind: 'risque', title: 'Contrat à renouveler avant vendredi', content: 'Autre formulation du même rappel pour le contrat qui expire.' }, {});
    expect(dup.isError).toBe(true);
    expect(await t.ctx.db.select().from(nudges)).toHaveLength(1);
    const posted = await t.ctx.db.select().from(messages).where(eq(messages.botId, bot.id));
    expect(posted.some((m) => m.meta.kind === 'nudge' && m.meta.nudgeId)).toBe(true);
    // The nudge tool only exists in heartbeat runs.
    const chatTools = antTools({ ...rc, run: { ...hbRun!, trigger: 'user' } });
    expect(chatTools.some((x) => x.name === 'nudge_create')).toBe(false);
  });

  it('heartbeat scheduling respects interval, pause and quiet hours', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev', heartbeatIntervalMin: 60 });
    const row = (await t.ctx.db.query.bots.findFirst({ where: eq(bots.id, bot.id) }))!;
    const settings = { ...DEFAULT_SETTINGS, quietHours: null };
    expect(heartbeatDue(row, settings)).toBe(true);
    expect(heartbeatDue({ ...row, lastHeartbeatAt: new Date(Date.now() - 30 * 60_000) }, settings)).toBe(false);
    expect(heartbeatDue({ ...row, lastHeartbeatAt: new Date(Date.now() - 61 * 60_000) }, settings)).toBe(true);
    expect(heartbeatDue({ ...row, paused: true }, settings)).toBe(false);
    expect(heartbeatDue(row, { ...settings, quietHours: { start: '00:00', end: '23:59' } })).toBe(false);
  });

  it('scheduler fires due routines and computes the next run', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'c' });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'chaque lundi', cron: '0 8 * * 1', instruction: 'Point hebdo' }, 'Europe/Zurich');
    await t.ctx.db.update(routines).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(routines.id, routine.id));
    await schedulerTick(workerDeps(t.ctx, fakeQuery(async function* () {}).query));
    const fired = await t.ctx.db.query.runs.findFirst({ where: eq(runs.trigger, 'routine') });
    expect(fired?.prompt).toBe('Point hebdo');
    expect(fired?.origin).toBe('autonomous');
    const after = await t.ctx.db.query.routines.findFirst({ where: eq(routines.id, routine.id) });
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after!.lastRunAt).toBeTruthy();
    const heartbeatJobs = await t.ctx.sql`select count(*)::int as n from jobs where kind = 'heartbeat'`;
    expect(heartbeatJobs[0]!.n).toBe(1);
  });

  it('daily digest summarises facts with Haiku and posts it', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'c' });
    await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'x' });
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.result('', 0.001, 'claude-haiku-5-5', 's', { markdown: '**Rien d’urgent.** 1 exécution hier.' });
    });
    await runDigest(workerDeps(t.ctx, query));
    expect(calls[0]!.prompt).toContain('Activité des bots');
    const digest = await t.ctx.db.query.messages.findFirst({ where: and(eq(messages.botId, bot.id), eq(messages.authorKind, 'bot')) });
    expect(digest?.content).toContain('Résumé du jour');
    expect(digest?.meta.kind).toBe('digest');
  });

  it('daily digest still posts raw facts when no compute is available', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'c' });
    const { query } = fakeQuery(async function* () {});
    await runDigest(workerDeps(t.ctx, query, { cfg: { ANTHROPIC_API_KEY: undefined } }));
    const digest = await t.ctx.db.query.messages.findFirst({ where: eq(messages.botId, bot.id) });
    expect(digest?.content).toContain('résumé brut');
  });

  it('rotates long sessions with a Haiku summary', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'd' });
    await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'user', content: 'On part sur PostgreSQL.' });
    const [session] = await t.ctx.db
      .insert(agentSessions)
      .values({ botId: bot.id, threadKey: bot.dmChannelId, sdkSessionId: 'old', approxTokens: 200_000 })
      .returning();
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.result('', 0.002, 'claude-haiku-5-5', 's', { summary: 'Décision : PostgreSQL.' });
    });
    expect(await rotateSession(workerDeps(t.ctx, query), session!.id)).toBe('ok');
    expect(calls[0]!.prompt).toContain('PostgreSQL');
    const all = await t.ctx.db.select().from(agentSessions).where(eq(agentSessions.botId, bot.id));
    expect(all.find((s) => s.id === session!.id)?.active).toBe(false);
    const fresh = all.find((s) => s.active)!;
    expect(fresh.sdkSessionId).toBeNull();
    expect(fresh.summary).toBe('Décision : PostgreSQL.');
    expect(fresh.generation).toBe(2);

    // The next run starts a new SDK session with the summary in its system prompt.
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'Et la suite ?' });
    const next = fakeQuery(async function* () {
      yield sdk.assistant('ok');
      yield sdk.result('ok', 0.01);
    });
    await executeRun(workerDeps(t.ctx, next.query), run!.id, new AbortController().signal);
    expect(next.calls[0]!.options.resume).toBeUndefined();
    expect(JSON.stringify(next.calls[0]!.options.systemPrompt)).toContain('Décision : PostgreSQL.');
  });

  it('sends budget alerts once per threshold and period', async () => {
    const day = localDateKey(new Date(), 'Europe/Zurich');
    const month = localMonthKey(new Date(), 'Europe/Zurich');
    await t.ctx.db.insert(runModelUsage).values({ day, month, model: 'claude-sonnet-5-5', computeSource: 'api', costUsd: 6.6 });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query);
    // Quiet hours off: during them, non-urgent alerts wait (see sched-alerts.test.ts).
    const settings = { ...DEFAULT_SETTINGS, quietHours: null };
    await checkBudgetAlerts(deps, settings);
    await checkBudgetAlerts(deps, settings);
    const rows = await t.ctx.db.select().from(budgetAlerts).where(eq(budgetAlerts.scope, 'api_day'));
    expect(rows.map((r) => r.threshold).sort((a, b) => a - b)).toEqual([50, 80]);
  });
});
