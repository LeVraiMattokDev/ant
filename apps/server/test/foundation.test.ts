import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_SETTINGS, settingsPatchSchema } from '@ant/shared';
import { channelReads, jobs, runModelUsage, runs, serviceStatus } from '../src/db/schema';
import { getSettings, updateSettings } from '../src/lib/settings';
import { approvalToDTO } from '../src/lib/dto';
import { createApproval } from '../src/services/approvals';
import { createBot } from '../src/services/bots';
import { listChannels } from '../src/services/channels';
import { createMessage } from '../src/services/messages';
import { forecastMonthUsd, patchComputeState, quotaStatus, recordUsage } from '../src/services/quota';
import { createRoutine, updateRoutine } from '../src/services/routines';
import { dispatchUserMessage, requestRun } from '../src/services/runs';
import { touchServiceStatus } from '../src/services/service-status';
import { createTask } from '../src/services/tasks';
import {
  WORKER_MODULES,
  moduleBuildPrompt,
  moduleDescribeTrigger,
  moduleJobHandler,
  moduleJobKinds,
  moduleSystemPromptSections,
  moduleTools,
  runAfterRunHooks,
  type FinishedRun,
  type WorkerModule,
} from '../src/worker/modules';
import { startWorker } from '../src/worker/main';
import { executeRun, usagePurposeOf } from '../src/worker/runner';
import type { RunContext } from '../src/worker/run-context';
import { schedulerTick } from '../src/worker/scheduler';
import { WEB_MODULES } from '../src/web/modules';
import { parseClientEvent } from '../src/web/ws';
import type { RunRow } from '../src/services/runs';
import { createTestDb, databaseAvailable, fakeQuery, sdk, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();

describe('realtime client events', () => {
  it('accepts ping and well-formed presence only', () => {
    expect(parseClientEvent('{"type":"ping"}')).toEqual({ type: 'ping' });
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseClientEvent(JSON.stringify({ type: 'focus', channelId: id, visible: true }))).toEqual({ type: 'focus', channelId: id, visible: true });
    expect(parseClientEvent(JSON.stringify({ type: 'focus', channelId: null, visible: false }))).toEqual({ type: 'focus', channelId: null, visible: false });
    expect(parseClientEvent(JSON.stringify({ type: 'focus', visible: true }))).toEqual({ type: 'focus', channelId: null, visible: true });
    expect(parseClientEvent(JSON.stringify({ type: 'focus', channelId: 'pas-un-uuid', visible: true }))).toBeNull();
    expect(parseClientEvent(JSON.stringify({ type: 'focus', channelId: id, visible: 'oui' }))).toBeNull();
    expect(parseClientEvent(JSON.stringify({ type: 'inconnu' }))).toBeNull();
    expect(parseClientEvent('pas du json')).toBeNull();
  });
});

describe('feature module registries', () => {
  it('lists the four feature modules in a fixed order, on both services', () => {
    expect(WORKER_MODULES.map((m) => m.name)).toEqual(['tracking', 'ops', 'inputs', 'capabilities']);
    expect(WEB_MODULES.map((m) => m.name)).toEqual(['tracking', 'ops', 'inputs', 'capabilities']);
  });

  const run = { id: 'r', trigger: 'followup', payload: {} } as unknown as RunRow;

  it('combines tools, prompt sections, job kinds; the first module that answers decides triggers and prompts', () => {
    const toolA = { name: 'a_tool' } as never;
    const a: WorkerModule = {
      name: 'a',
      tools: () => [toolA],
      systemPromptSection: () => '# A',
      describeTrigger: (r) => (r.trigger === 'followup' ? 'suivi A' : null),
      buildPrompt: () => null,
      jobs: { 'followup.fire': async () => undefined },
    };
    const b: WorkerModule = {
      name: 'b',
      tools: () => [],
      systemPromptSection: () => '  ',
      describeTrigger: () => 'suivi B',
      buildPrompt: (_r, head) => `${head}B`,
      jobs: { 'watch.check': async () => undefined, 'followup.fire': async () => undefined },
    };
    expect(moduleTools({} as RunContext, [a, b])).toEqual([toolA]);
    expect(moduleSystemPromptSections({} as never, {} as never, [a, b])).toEqual(['# A']);
    expect(moduleDescribeTrigger(run, [a, b])).toBe('suivi A');
    expect(moduleBuildPrompt(run, 'tête ', [a, b])).toBe('tête B');
    expect(moduleBuildPrompt(run, 'tête ', [a])).toBeNull();
    expect(moduleJobKinds([a, b]).sort()).toEqual(['followup.fire', 'watch.check']);
    expect(moduleJobHandler('followup.fire', [a, b])).toBe(a.jobs!['followup.fire']);
    expect(moduleJobHandler('diagnostic', [a, b])).toBeNull();
  });

  it('isolates a failing afterRun hook from the next modules', async () => {
    const seen: string[] = [];
    const failing: WorkerModule = {
      name: 'failing',
      afterRun: async () => {
        throw new Error('boum');
      },
    };
    const next: WorkerModule = { name: 'next', afterRun: async (_d, _s, f) => void seen.push(f.status) };
    await expect(runAfterRunHooks({} as never, DEFAULT_SETTINGS, { status: 'done' } as FinishedRun, [failing, next])).resolves.toBeUndefined();
    expect(seen).toEqual(['done']);
  });

  it('records the origin of a continued run as the origin of the run it continues', () => {
    expect(usagePurposeOf({ trigger: 'routine', payload: {} })).toBe('routine');
    expect(usagePurposeOf({ trigger: 'system', payload: { continuedTrigger: 'routine' } })).toBe('routine');
    expect(usagePurposeOf({ trigger: 'system', payload: { continuedTrigger: 'n’importe quoi' } })).toBe('system');
  });
});

describe('settings of the feature modules', () => {
  it('has defaults, and PATCH /api/settings cannot write the server-managed keys', () => {
    expect(DEFAULT_SETTINGS.completionPush).toBe('long');
    expect(DEFAULT_SETTINGS.emergencyStop).toBeNull();
    expect(DEFAULT_SETTINGS.onboardingDoneAt).toBeNull();
    const parsed = settingsPatchSchema.parse({
      completionPush: 'never',
      emergencyStop: { at: new Date().toISOString(), reason: null, pausedBotIds: [], cancelledRuns: 0, rejectedApprovals: 0 },
      grantsRevokedAt: new Date().toISOString(),
    });
    expect(parsed).toEqual({ completionPush: 'never' });
  });

  it('projects the month’s API spend linearly', () => {
    // 15 October 12:00 in Zurich: 14.5 days elapsed out of 31.
    expect(forecastMonthUsd(29, 'Europe/Zurich', new Date('2026-10-15T10:00:00Z'))).toBe(62);
    expect(forecastMonthUsd(0, 'Europe/Zurich', new Date('2026-10-01T00:30:00Z'))).toBe(0);
  });
});

describe.skipIf(!hasDb)('foundation of the feature modules (database)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate runs, run_model_usage, messages, jobs, agent_sessions, approvals, channel_members, channels, channel_reads, bots, routines, tasks, compute_state, service_status, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
  });

  async function dmRun(prompt = 'Bonjour') {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Surveille le web' });
    const msg = await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'user', content: prompt });
    const [run] = await dispatchUserMessage(t.ctx, msg);
    return { bot, run: run! };
  }

  const answer = (text: string, session: string) =>
    fakeQuery(async function* () {
      yield sdk.init(session);
      yield sdk.assistant(text, session);
      yield sdk.result(text, 0.01, 'claude-sonnet-5-5', session);
    });

  it('reports the worker alive from its service_status row', async () => {
    const settings = await getSettings(t.ctx.db);
    expect((await quotaStatus(t.ctx, settings)).worker).toEqual({ lastSeenAt: null, alive: false });
    await touchServiceStatus(t.ctx, 'worker', { workerId: 'w' });
    expect((await quotaStatus(t.ctx, settings)).worker?.alive).toBe(true);
    await t.ctx.db.update(serviceStatus).set({ seenAt: new Date(Date.now() - 5 * 60_000) }).where(eq(serviceStatus.key, 'worker'));
    expect((await quotaStatus(t.ctx, settings)).worker?.alive).toBe(false);
    expect(typeof (await quotaStatus(t.ctx, settings)).api.forecastMonthUsd).toBe('number');
  });

  it('records the origin of each run’s usage, and caps subscription runs', async () => {
    const { run } = await dmRun();
    const { query, calls } = answer('Bonjour !', 'sess-f1');
    await executeRun(workerDeps(t.ctx, query), run.id, new AbortController().signal);
    expect(calls[0]!.options.maxBudgetUsd).toBe(DEFAULT_SETTINGS.perRunSubscriptionCapUsd);
    const [usage] = await t.ctx.db.select().from(runModelUsage);
    expect(usage?.purpose).toBe('user');
    expect(usage?.routineId).toBeNull();

    await updateSettings(t.ctx.db, { perRunSubscriptionCapUsd: 0 });
    const second = await dmRun('Encore');
    const again = answer('Re', 'sess-f2');
    await executeRun(workerDeps(t.ctx, again.query), second.run.id, new AbortController().signal);
    expect(again.calls[0]!.options.maxBudgetUsd).toBeUndefined();
  });

  it('keeps the routine and the model of a run continued after the step limit', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Fais le point' }, 'Europe/Zurich');
    const run = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      trigger: 'routine',
      priority: 'background',
      origin: 'autonomous',
      prompt: 'Fais le point',
      payload: { routineId: routine.id },
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    expect(run?.model).toBe('claude-opus-5-5');
    const { query } = fakeQuery(async function* () {
      yield sdk.init('sess-f3');
      const result = sdk.result('', 0.02, 'claude-opus-5-5', 'sess-f3') as unknown as Record<string, unknown>;
      yield { ...result, subtype: 'error_max_turns', is_error: true, errors: [] } as unknown as SDKMessage;
    });
    await updateSettings(t.ctx.db, { computeMode: 'api_only' });
    await executeRun(workerDeps(t.ctx, query), run!.id, new AbortController().signal);
    const [usage] = await t.ctx.db.select().from(runModelUsage);
    expect(usage?.purpose).toBe('routine');
    expect(usage?.routineId).toBe(routine.id);
    const next = await t.ctx.db.query.runs.findFirst({ where: and(eq(runs.botId, bot.id), eq(runs.trigger, 'system')) });
    expect(next?.model).toBe('claude-opus-5-5');
    expect(next?.effort).toBe('high');
    expect(next?.payload.routineId).toBe(routine.id);
    expect(next?.payload.continuedTrigger).toBe('routine');
  });

  it('stores no malformed routine id with a usage record', async () => {
    await recordUsage(
      t.ctx,
      [{ runId: null, botId: null, purpose: 'routine', routineId: 'pas-un-uuid', source: 'api', model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }],
      'Europe/Zurich',
    );
    const [row] = await t.ctx.db.select().from(runModelUsage);
    expect(row?.purpose).toBe('routine');
    expect(row?.routineId).toBeNull();
  });

  it('applies a one-off model to the runs of a message', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'Assistant' });
    const msg = await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'user', content: 'Analyse en profondeur' });
    const [run] = await dispatchUserMessage(t.ctx, msg, { model: 'claude-opus-5-5', effort: 'high', payload: { depth: 'expert' } });
    expect(run?.model).toBe('claude-opus-5-5');
    expect(run?.effort).toBe('high');
    const row = await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run!.id) });
    expect(row?.payload.depth).toBe('expert');
  });

  it('flags routines proposed by a bot until the owner enables them', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    const proposal = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Point', enabled: false }, 'Europe/Zurich', { proposed: true });
    expect(proposal.proposed).toBe(true);
    expect(proposal.silentIfNothing).toBe(false);
    expect(proposal.completionPush).toBeNull();
    const enabled = await updateRoutine(t.ctx, proposal.id, { enabled: true, silentIfNothing: true, completionPush: 'never' });
    expect(enabled.proposed).toBe(false);
    expect(enabled.silentIfNothing).toBe(true);
    expect(enabled.completionPush).toBe('never');
    const own = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 9 * * 1', instruction: 'Point', enabled: false }, 'Europe/Zurich');
    expect(own.proposed).toBe(false);
  });

  it('starts no heartbeat or routine while the emergency stop is engaged', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Point' }, 'Europe/Zurich');
    await t.ctx.sql`update routines set next_run_at = now() - interval '1 minute'`;
    const noon = new Date();
    await updateSettings(t.ctx.db, {
      quietHours: null,
      emergencyStop: { at: noon.toISOString(), reason: 'test', pausedBotIds: [], cancelledRuns: 0, rejectedApprovals: 0 },
    });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query);
    await schedulerTick(deps, noon);
    expect(await t.ctx.db.select().from(jobs).where(eq(jobs.kind, 'heartbeat'))).toHaveLength(0);
    expect(await t.ctx.db.select().from(runs)).toHaveLength(0);

    await updateSettings(t.ctx.db, { emergencyStop: null });
    await schedulerTick(deps, noon);
    expect(await t.ctx.db.select().from(jobs).where(eq(jobs.kind, 'heartbeat'))).toHaveLength(1);
    expect(await t.ctx.db.select().from(runs).where(eq(runs.trigger, 'routine'))).toHaveLength(1);
  });

  it('serves the owner’s read mark, the bot’s completion push, the task assignee and the grant revocation', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur', completionPush: 'always' });
    expect(bot.completionPush).toBe('always');
    const at = new Date('2026-10-12T08:00:00.000Z');
    await t.ctx.db.insert(channelReads).values({ channelId: bot.dmChannelId, lastReadAt: at });
    const [dm] = await listChannels(t.ctx);
    expect(dm?.lastReadAt).toBe(at.toISOString());

    expect((await createTask(t.ctx, { botId: bot.id, title: 'Suivre' })).assignee).toBe('bot');
    expect((await createTask(t.ctx, { botId: bot.id, title: 'Valider le devis', assignee: 'owner' })).assignee).toBe('owner');

    const approval = await createApproval(t.ctx, {
      runId: null,
      botId: bot.id,
      channelId: null,
      threadRootId: null,
      category: 'compte',
      tool: 'request_approval',
      summary: 'Agir sur linkedin.com',
      payload: { domain: 'linkedin.com' },
      expiryHours: 1,
    });
    expect(approval.revokedAt).toBeNull();
    const row = await t.ctx.db.query.approvals.findFirst();
    expect(approvalToDTO({ ...row!, revokedAt: at }).revokedAt).toBe(at.toISOString());
  });

  it('writes the worker liveness when the worker starts', async () => {
    const handle = await startWorker(
      { ...workerDeps(t.ctx, fakeQuery(async function* () {}).query).cfg, DATABASE_URL: t.url },
      { query: fakeQuery(async function* () {}).query, migrate: false },
    );
    try {
      const row = await t.ctx.db.query.serviceStatus.findFirst({ where: eq(serviceStatus.key, 'worker') });
      expect(row?.detail).toMatchObject({ workerId: 'test-worker', subscriptionConfigured: true, apiConfigured: true });
      expect((await quotaStatus(t.ctx, await getSettings(t.ctx.db))).worker?.alive).toBe(true);
    } finally {
      await handle.stop();
    }
  });
});
