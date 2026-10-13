import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agentSessions, approvals, bots, budgetAlerts, routines, runs, subscriptionEvents } from '../src/db/schema';
import { updateSettings } from '../src/lib/settings';
import { createApproval } from '../src/services/approvals';
import { createBot } from '../src/services/bots';
import { createMessage } from '../src/services/messages';
import type { PushPayload, PushSender } from '../src/services/push';
import { getComputeState, patchComputeState, quotaStatus, recordRateLimitEvent } from '../src/services/quota';
import { createRoutine, routineThreadKey } from '../src/services/routines';
import { updateRun } from '../src/services/runs';
import type { WorkerDeps } from '../src/worker/deps';
import { runHeartbeat } from '../src/worker/heartbeat';
import { rotateSession } from '../src/worker/rotate';
import { executeRun } from '../src/worker/runner';
import { maintenance, schedulerTick } from '../src/worker/scheduler';
import { DEFAULT_SETTINGS } from '@ant/shared';
import { createTestDb, databaseAvailable, fakeQuery, sdk, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();
const DAY = 86_400_000;

describe.skipIf(!hasDb)('scheduler', () => {
  let t: TestDb;
  let pushes: PushPayload[];
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate runs, run_model_usage, messages, jobs, agent_sessions, approvals, nudges, routines, tasks, memory_items, channel_members, channels, bots, compute_state, budget_alerts, subscription_events, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
    await updateSettings(t.ctx.db, { quietHours: null, digestEnabled: false });
    pushes = [];
  });

  function deps(query = fakeQuery(async function* () {}).query): WorkerDeps {
    const d = workerDeps(t.ctx, query);
    d.push = { enabled: true, sendToAll: async (p: PushPayload) => (pushes.push(p), 1) } as unknown as PushSender;
    return d;
  }

  it('fires a due routine once when scheduler passes overlap', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'c', heartbeatEnabled: false });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'chaque lundi', cron: '0 8 * * 1', instruction: 'Point hebdo' }, 'Europe/Zurich');
    await t.ctx.db.update(routines).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(routines.id, routine.id));
    const d = deps();
    await Promise.all(Array.from({ length: 4 }, () => schedulerTick(d)));
    expect(await t.ctx.db.select().from(runs).where(eq(runs.trigger, 'routine'))).toHaveLength(1);
  });

  it('does not fire a routine disabled after it was read as due', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'c', heartbeatEnabled: false });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Point' }, 'Europe/Zurich');
    const due = { ...(await t.ctx.db.query.routines.findFirst({ where: eq(routines.id, routine.id) }))!, nextRunAt: new Date(Date.now() - 1000) };
    await t.ctx.db.update(routines).set({ enabled: false, nextRunAt: null }).where(eq(routines.id, routine.id));
    const { advanceRoutine } = await import('../src/services/routines');
    expect(await advanceRoutine(t.ctx, due)).toBe(false);
  });

  it('runs each routine in its own agent session, apart from the conversation it posts in', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'c', heartbeatEnabled: false });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'chaque matin', cron: '0 8 * * *', instruction: 'Point du matin' }, 'Europe/Zurich');
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.init('sess-routine');
      yield sdk.assistant('Rien de neuf.', 'sess-routine');
      yield sdk.result('Rien de neuf.', 0.01, 'claude-sonnet-5-5', 'sess-routine');
    });
    const d = deps(query);
    for (let i = 0; i < 2; i++) {
      await t.ctx.db.update(routines).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(routines.id, routine.id));
      await schedulerTick(d);
      const run = await t.ctx.db.query.runs.findFirst({ where: and(eq(runs.trigger, 'routine'), eq(runs.status, 'queued')) });
      expect(run?.threadKey).toBe(routineThreadKey(routine.id));
      expect(run?.channelId).toBe(bot.dmChannelId);
      await executeRun(d, run!.id, new AbortController().signal);
    }
    expect(calls).toHaveLength(2);
    // The second occurrence resumes the routine's session, not the private conversation's.
    expect(calls[1]!.options.resume).toBe('sess-routine');
    const sessions = await t.ctx.db.select().from(agentSessions).where(eq(agentSessions.botId, bot.id));
    expect(sessions.map((s) => s.threadKey)).toEqual([routineThreadKey(routine.id)]);
  });

  it('summarises a routine session from its own runs when it is rotated', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'c', heartbeatEnabled: false });
    const key = routineThreadKey('7c6f2f7e-0d55-4c43-9a43-2b7c0e0a1b2c');
    const [run] = await t.ctx.db
      .insert(runs)
      .values({ botId: bot.id, channelId: bot.dmChannelId, threadKey: key, trigger: 'routine', priority: 'background', origin: 'autonomous', chainId: crypto.randomUUID(), model: 'claude-sonnet-5-5', effort: 'medium', prompt: 'Point des ventes', status: 'done' })
      .returning();
    const answer = await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'bot', botId: bot.id, content: 'Ventes de la semaine : 42 commandes.' });
    await updateRun(t.ctx, run!.id, { responseMessageId: answer.id });
    const [session] = await t.ctx.db.insert(agentSessions).values({ botId: bot.id, threadKey: key, sdkSessionId: 'old', approxTokens: 200_000 }).returning();
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.result('', 0.002, 'claude-haiku-5-5', 's', { summary: 'Semaine 1 : 42 commandes.' });
    });
    expect(await rotateSession(deps(query), session!.id)).toBe('ok');
    expect(calls[0]!.prompt).toContain('Point des ventes');
    expect(calls[0]!.prompt).toContain('42 commandes');
    expect(JSON.stringify(calls[0]!.options.systemPrompt)).toContain('routine');
    const fresh = await t.ctx.db.query.agentSessions.findFirst({ where: and(eq(agentSessions.threadKey, key), eq(agentSessions.active, true)) });
    expect(fresh?.summary).toBe('Semaine 1 : 42 commandes.');
  });

  it('runs a heartbeat once even when two of its jobs were queued', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'v', heartbeatIntervalMin: 60 });
    await t.ctx.db.update(bots).set({ lastHeartbeatAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(bots.id, bot.id));
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.result('', 0.0008, 'claude-haiku-5-5', 's', { creuser: false, sujets: [] });
    });
    const d = deps(query);
    const outcomes = await Promise.all([runHeartbeat(d, bot.id), runHeartbeat(d, bot.id)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['nothing', 'skipped']);
    // A job left waiting across the next slot boundary is skipped too.
    expect((await runHeartbeat(d, bot.id, false, new Date(Date.now() + 30_000))).status).toBe('skipped');
    expect(calls).toHaveLength(1);
    // Forced from the interface, it still runs.
    expect((await runHeartbeat(d, bot.id, true)).status).toBe('nothing');
  });

  it('keeps a weekly limit when the 5-hour window resets', async () => {
    const now = Date.now();
    await recordRateLimitEvent(t.ctx, { status: 'allowed', rateLimitType: 'five_hour', utilization: 40, resetsAt: Math.floor((now - 60_000) / 1000) });
    const weekly = new Date(now + 3 * DAY);
    await recordRateLimitEvent(t.ctx, { status: 'rejected', rateLimitType: 'seven_day', resetsAt: Math.floor(weekly.getTime() / 1000) });
    await schedulerTick(deps());
    const state = await getComputeState(t.ctx);
    expect(state.subLimitedUntil?.getTime()).toBe(Math.floor(weekly.getTime() / 1000) * 1000);
    expect(state.subFiveHourUtil).toBe(0);
    expect(state.subFiveHourResetsAt).toBeNull();
    const status = await quotaStatus(t.ctx, DEFAULT_SETTINGS);
    expect(status.subscription.health).toBe('limited');
    expect(pushes).toHaveLength(0);
  });

  it('announces the end of a subscription limit once', async () => {
    await patchComputeState(t.ctx, { subLimitedUntil: new Date(Date.now() - 1000), subLastStatus: 'rejected' });
    const d = deps();
    await Promise.all([schedulerTick(d), schedulerTick(d), schedulerTick(d)]);
    expect(pushes.filter((p) => p.tag === 'sub-restored')).toHaveLength(1);
    const state = await getComputeState(t.ctx);
    expect(state.subLimitedUntil).toBeNull();
    expect(state.subLastStatus).toBe('allowed');
  });

  it('purges old rate-limit events, alert records and decided approval captures', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 100 * DAY);
    const bot = await createBot(t.ctx, { name: 'Web', role: 'w', heartbeatEnabled: false });
    await t.ctx.db.insert(subscriptionEvents).values([
      { at: old, status: 'allowed', raw: {} },
      { at: now, status: 'allowed', raw: {} },
    ]);
    await t.ctx.db.insert(budgetAlerts).values([
      { scope: 'api_day', periodKey: 'ancien', threshold: 50, sentAt: old },
      { scope: 'api_day', periodKey: 'récent', threshold: 50, sentAt: now },
    ]);
    const base = { runId: null, botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, category: 'navigateur_sensible' as const, tool: 'browser', summary: 'Clic', payload: {}, expiryHours: 72000, screenshotPng: 'aGVsbG8=' };
    const decidedOld = await createApproval(t.ctx, base);
    const pendingOld = await createApproval(t.ctx, base);
    const decidedNew = await createApproval(t.ctx, base);
    await t.ctx.db.update(approvals).set({ createdAt: old, status: 'executed' }).where(eq(approvals.id, decidedOld.id));
    await t.ctx.db.update(approvals).set({ createdAt: old }).where(eq(approvals.id, pendingOld.id));
    await t.ctx.db.update(approvals).set({ status: 'rejected' }).where(eq(approvals.id, decidedNew.id));

    await maintenance(deps(), now);

    expect((await t.ctx.db.select().from(subscriptionEvents)).map((e) => e.at.getTime())).toEqual([now.getTime()]);
    expect((await t.ctx.db.select().from(budgetAlerts)).map((a) => a.periodKey)).toEqual(['récent']);
    const shots = new Map((await t.ctx.db.select().from(approvals)).map((a) => [a.id, a.screenshotPng]));
    expect(shots.get(decidedOld.id)).toBeNull();
    expect(shots.get(pendingOld.id)).toBe('aGVsbG8=');
    expect(shots.get(decidedNew.id)).toBe('aGVsbG8=');
  });
});
