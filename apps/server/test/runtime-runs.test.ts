import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_BOT_PERMISSIONS, DEFAULT_SETTINGS, localDateKey, localMonthKey } from '@ant/shared';
import { agentSessions, approvals, auditLog, budgetAlerts, handoffs, jobs, messages, runModelUsage, runs } from '../src/db/schema';
import { claimJob, deferJob } from '../src/lib/jobs';
import { getSettings, updateSettings } from '../src/lib/settings';
import { createBot } from '../src/services/bots';
import { createGroupChannel } from '../src/services/channels';
import { createMessage, updateMessage } from '../src/services/messages';
import { getComputeState, patchComputeState } from '../src/services/quota';
import { cancelRun, dispatchUserMessage, failRun, getRun, requestRun, sweepOrphanRuns, updateRun } from '../src/services/runs';
import { decideCompute, releaseApiBudget, reservedApiBudget } from '../src/worker/compute';
import type { QueryFn } from '../src/worker/deps';
import { startWorker } from '../src/worker/main';
import type { RunContext } from '../src/worker/run-context';
import { SHUTDOWN_REASON, executeRun } from '../src/worker/runner';
import { antTools } from '../src/worker/tools';
import { createTestDb, databaseAvailable, fakeQuery, sdk, stubComputer, workerConfig, workerDeps, type RecordedCall, type TestDb } from './helpers';

const hasDb = await databaseAvailable();

/** A result whose modelUsage carries the given (cumulative) totals, as the SDK reports them. */
function resultWith(sessionId: string, totals: { cost: number; input: number; output: number }, extra: Record<string, unknown> = {}): SDKMessage {
  const base = sdk.result('ok', totals.cost, 'claude-sonnet-5-5', sessionId) as unknown as Record<string, unknown>;
  return {
    ...base,
    modelUsage: {
      'claude-sonnet-5-5': {
        inputTokens: totals.input,
        outputTokens: totals.output,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: totals.cost,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      },
    },
    ...extra,
  } as unknown as SDKMessage;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not reached in time');
}

describe.skipIf(!hasDb)('runtime: runs, sessions and accounting', () => {
  let t: TestDb;
  const signal = () => new AbortController().signal;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate runs, run_model_usage, messages, jobs, agent_sessions, approvals, handoffs, nudges, tasks, channel_members, channels, bots, compute_state, budget_alerts, subscription_events, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
    await updateSettings(t.ctx.db, { quietHours: null });
  });

  async function dmRun(prompt = 'Bonjour') {
    const bot = await createBot(t.ctx, { name: 'Chef de cabinet', role: 'Assistant principal' });
    const msg = await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'user', content: prompt });
    const [run] = await dispatchUserMessage(t.ctx, msg);
    return { bot, run: run! };
  }

  async function nextDmRun(dmChannelId: string, prompt: string) {
    const msg = await createMessage(t.ctx, { channelId: dmChannelId, authorKind: 'user', content: prompt });
    const [run] = await dispatchUserMessage(t.ctx, msg);
    return run!;
  }

  // ─────────────── Accounting of resumed sessions (high) ───────────────

  it('records only the new spend of a resumed session, whose result carries cumulative totals', async () => {
    const { bot, run } = await dmRun('Premier');
    const { query, calls } = fakeQuery(async function* (_call, index) {
      yield sdk.init('sess-u');
      yield sdk.assistant('ok', 'sess-u');
      if (index === 0) yield resultWith('sess-u', { cost: 0.1, input: 1000, output: 100 });
      // Resumed: the CLI restored 0.10 from the transcript and adds this turn's 0.08.
      else if (index === 1) yield resultWith('sess-u', { cost: 0.18, input: 1800, output: 180 });
      // Totals lower than the baseline: the CLI restarted from zero, everything is new.
      else yield resultWith('sess-u', { cost: 0.05, input: 500, output: 50 });
    });
    const deps = workerDeps(t.ctx, query);
    await executeRun(deps, run.id, signal());
    const run2 = await nextDmRun(bot.dmChannelId, 'Deuxième');
    await executeRun(deps, run2.id, signal());
    const run3 = await nextDmRun(bot.dmChannelId, 'Troisième');
    await executeRun(deps, run3.id, signal());
    expect(calls[1]!.options.resume).toBe('sess-u');
    expect(calls[2]!.options.resume).toBe('sess-u');

    const usage = await t.ctx.db.select().from(runModelUsage);
    const total = usage.reduce((s, u) => s + u.costUsd, 0);
    expect(total).toBeCloseTo(0.23, 6);
    const second = await getRun(t.ctx, run2.id);
    expect(second!.costUsd).toBeCloseTo(0.08, 6);
    expect(second!.inputTokens).toBe(800);
    expect(second!.outputTokens).toBe(80);
    const third = await getRun(t.ctx, run3.id);
    expect(third!.costUsd).toBeCloseTo(0.05, 6);
  });

  it('does not count the first attempt twice when a run switches source and resumes its session', async () => {
    await updateSettings(t.ctx.db, { computeMode: 'subscription_then_api' });
    const { run } = await dmRun();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const { query } = fakeQuery(async function* (_call, index) {
      if (index === 0) {
        yield sdk.init('sess-w');
        yield sdk.rateLimit('rejected', { rateLimitType: 'five_hour', resetsAt, utilization: 1 }, 'sess-w');
        yield resultWith('sess-w', { cost: 0.02, input: 200, output: 20 });
        return;
      }
      yield sdk.assistant('Fini', 'sess-w');
      yield resultWith('sess-w', { cost: 0.05, input: 500, output: 50 });
    });
    await executeRun(workerDeps(t.ctx, query), run.id, signal());
    const usage = await t.ctx.db.select().from(runModelUsage);
    const by = (source: string) => usage.filter((u) => u.computeSource === source).reduce((s, u) => s + u.costUsd, 0);
    expect(by('subscription')).toBeCloseTo(0.02, 6);
    expect(by('api')).toBeCloseTo(0.03, 6);
    expect((await getRun(t.ctx, run.id))!.costUsd).toBeCloseTo(0.05, 6);
  });

  // ─────────────── Stable system prompt (high) ───────────────

  it('keeps the system prompt identical across the runs of a session and sends the run context in the user message', async () => {
    const { bot, run } = await dmRun('Bonjour');
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.init('sess-p');
      yield sdk.assistant('ok', 'sess-p');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-p');
    });
    await executeRun(workerDeps(t.ctx, query), run.id, signal());
    // A different trigger in the same conversation (it used to change the system prompt).
    const approvalRun = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      trigger: 'approval',
      priority: 'interactive',
      origin: 'user',
      prompt: 'La validation « Publier » a été approuvée.',
    });
    await executeRun(workerDeps(t.ctx, query), approvalRun!.id, signal());

    expect(calls[1]!.options.resume).toBe('sess-p');
    expect(calls[0]!.options.systemPrompt).toMatchObject({ type: 'custom', snapshot: false });
    expect(calls[1]!.options.systemPrompt).toEqual(calls[0]!.options.systemPrompt);
    expect(JSON.stringify(calls[0]!.options.systemPrompt)).not.toContain('Date et heure');
    expect(calls[0]!.prompt).toContain('Date et heure');
    expect(calls[0]!.prompt).toContain('le propriétaire t’écrit');
    expect(calls[1]!.prompt).toContain('Date et heure');
    expect(calls[1]!.prompt).toContain('retour d’une validation du propriétaire');
    expect(calls[1]!.prompt).toContain('La validation « Publier » a été approuvée.');
  });

  it('keeps the rotation summary in the system prompt for every run of the new session', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'c' });
    await t.ctx.db.insert(agentSessions).values({ botId: bot.id, threadKey: bot.dmChannelId, generation: 2, summary: 'Décision : PostgreSQL.', lastSeenAt: new Date() });
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.init('sess-g2');
      yield sdk.assistant('ok', 'sess-g2');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-g2');
    });
    const first = await nextDmRun(bot.dmChannelId, 'Et la suite ?');
    await executeRun(workerDeps(t.ctx, query), first.id, signal());
    const second = await nextDmRun(bot.dmChannelId, 'Et après ?');
    await executeRun(workerDeps(t.ctx, query), second.id, signal());
    expect(calls[0]!.options.resume).toBeUndefined();
    expect(calls[1]!.options.resume).toBe('sess-g2');
    expect(JSON.stringify(calls[0]!.options.systemPrompt)).toContain('Décision : PostgreSQL.');
    expect(JSON.stringify(calls[1]!.options.systemPrompt)).toContain('Décision : PostgreSQL.');
    expect(calls[1]!.options.systemPrompt).toEqual(calls[0]!.options.systemPrompt);
  });

  // ─────────────── Restarts, crashes, lost sessions ───────────────

  function stoppableQuery(sessionId: string) {
    const calls: RecordedCall[] = [];
    const running = deferred();
    const query = ((params: { prompt: string; options: RecordedCall['options'] & { abortController: AbortController } }) => {
      calls.push({ prompt: params.prompt, options: params.options });
      const abortSignal = params.options.abortController.signal;
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield sdk.init(sessionId);
        yield sdk.delta('Je commence', sessionId);
        running.resolve();
        await new Promise<void>((r) => (abortSignal.aborted ? r() : abortSignal.addEventListener('abort', () => r())));
        throw new Error('Claude Code process aborted by user');
      })();
    }) as unknown as QueryFn;
    return { query, calls, running: running.promise };
  }

  it('puts a run back in the queue on worker shutdown and resumes its session at the next start', async () => {
    const { bot, run } = await dmRun('Lance la migration');
    const { query, running } = stoppableQuery('sess-z');
    const controller = new AbortController();
    const pending = executeRun(workerDeps(t.ctx, query), run.id, controller.signal);
    await running;
    controller.abort(SHUTDOWN_REASON);
    const res = await pending;
    expect(res.outcome).toBe('deferred');
    expect(res.outcome === 'deferred' && res.until.getTime() - Date.now()).toBeLessThan(10_000);
    const row = await getRun(t.ctx, run.id);
    expect(row?.status).toBe('queued');
    expect(row?.payload.restartResume).toBe(true);
    expect(row?.activity).toBeNull();
    const partial = await t.ctx.db.query.messages.findFirst({ where: and(eq(messages.runId, run.id), eq(messages.authorKind, 'bot')) });
    expect(partial?.status).toBe('done');
    expect(partial?.content).toContain('Je commence');
    expect(partial?.content).toContain('redémarrage');

    const next = fakeQuery(async function* () {
      yield sdk.init('sess-z');
      yield sdk.assistant('Migration terminée.', 'sess-z');
      yield sdk.result('Migration terminée.', 0.01, 'claude-sonnet-5-5', 'sess-z');
    });
    expect((await executeRun(workerDeps(t.ctx, next.query), run.id, signal())).outcome).toBe('done');
    expect(next.calls[0]!.options.resume).toBe('sess-z');
    expect(next.calls[0]!.prompt).toContain('Ant a redémarré pendant ta tâche');
    expect(next.calls[0]!.prompt).not.toContain('Message du propriétaire');
    const all = await t.ctx.db.select().from(messages).where(eq(messages.botId, bot.id));
    expect(all.some((m) => m.status === 'streaming')).toBe(false);
  });

  it('a run requeued by a shutdown keeps its place, and replays its request if a later message used its session', async () => {
    const { bot, run } = await dmRun('REQUETE-R1 : migre la base');
    const { query, running } = stoppableQuery('sess-q');
    const controller = new AbortController();
    const pending = executeRun(workerDeps(t.ctx, query), run.id, controller.signal);
    await running;
    // The owner writes again while R1 is still working: R2 waits in the same lane.
    const r2 = await nextDmRun(bot.dmChannelId, 'REQUETE-R2 : et la météo ?');
    controller.abort(SHUTDOWN_REASON);
    const res = await pending;
    expect(res.outcome).toBe('deferred');
    expect(res.outcome === 'deferred' && res.until.getTime()).toBeLessThanOrEqual(Date.now());

    // What main.ts does with the outcome, then the next worker claims: R1 first.
    const [r1Job] = await t.ctx.db.select().from(jobs).where(sql`${jobs.payload}->>'runId' = ${run.id}`);
    await t.ctx.db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, r1Job!.id));
    await deferJob(t.ctx.db, r1Job!.id, res.outcome === 'deferred' ? res.until : new Date(), 'arrêt du worker');
    expect((await claimJob(t.ctx.sql, 'test-worker', ['bot.run']))?.payload.runId).toBe(run.id);

    // Even so (an interactive message overtaking a normal run, a job retried later…), R2 may use the session first.
    const next = fakeQuery(async function* (_call, index) {
      yield sdk.init('sess-q');
      yield sdk.assistant(index === 0 ? 'Il fait beau.' : 'Migration terminée.', 'sess-q');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-q');
    });
    expect((await executeRun(workerDeps(t.ctx, next.query), r2.id, signal())).outcome).toBe('done');
    expect((await executeRun(workerDeps(t.ctx, next.query), run.id, signal())).outcome).toBe('done');
    const r1Call = next.calls[1]!;
    expect(r1Call.options.resume).toBe('sess-q');
    expect(r1Call.prompt).toContain('Message du propriétaire :\nREQUETE-R1 : migre la base');
    expect(r1Call.prompt).toContain('interrompue par un redémarrage d’Ant');
    expect(r1Call.prompt).not.toContain('Ant a redémarré pendant ta tâche');
  });

  it('after a crash, replays the request when another run used the session in the meantime', async () => {
    const { bot, run } = await dmRun('REQUETE-C1 : range les fichiers');
    const started = deferred();
    const hanging = (() =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield sdk.init('sess-c1');
        started.resolve();
        await new Promise(() => undefined);
      })()) as unknown as QueryFn;
    void executeRun(workerDeps(t.ctx, hanging), run.id, signal());
    await started.promise;
    await waitFor(async () => typeof (await getRun(t.ctx, run.id))?.payload.sessionUsedAt === 'string', 5_000);

    const other = await nextDmRun(bot.dmChannelId, 'REQUETE-C2 : une question rapide');
    const next = fakeQuery(async function* () {
      yield sdk.init('sess-c1');
      yield sdk.assistant('ok', 'sess-c1');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-c1');
    });
    await executeRun(workerDeps(t.ctx, next.query), other.id, signal());
    expect(next.calls[0]!.options.resume).toBe('sess-c1');
    // The crashed run's job is replayed afterwards.
    expect((await executeRun(workerDeps(t.ctx, next.query), run.id, signal())).outcome).toBe('done');
    expect(next.calls[1]!.options.resume).toBe('sess-c1');
    expect(next.calls[1]!.prompt).toContain('REQUETE-C1 : range les fichiers');
    expect(next.calls[1]!.prompt).toContain('interrompue par un redémarrage d’Ant');
  });

  it('stops a cancelled turn through interrupt() and records the usage of its final result', async () => {
    const { run } = await dmRun('Longue tâche');
    const running = deferred();
    const stopped = deferred();
    let interrupts = 0;
    let sdkAbort: AbortController | undefined;
    const query = ((params: { prompt: string; options: { abortController: AbortController } }) => {
      sdkAbort = params.options.abortController;
      const turn = (async function* (): AsyncGenerator<SDKMessage> {
        yield sdk.init('sess-i');
        yield sdk.delta('Je commence', 'sess-i');
        running.resolve();
        const killed = new Promise<never>((_, reject) => sdkAbort!.signal.addEventListener('abort', () => reject(new Error('Claude Code process aborted by user'))));
        await Promise.race([stopped.promise, killed]);
        // Interrupted: the CLI still ends the turn with a result carrying its exact usage.
        yield resultWith('sess-i', { cost: 0.07, input: 700, output: 70 }, { subtype: 'error_during_execution', is_error: true, errors: [] });
      })();
      return Object.assign(turn, {
        interrupt: async () => {
          interrupts++;
          stopped.resolve();
        },
      });
    }) as unknown as QueryFn;
    const controller = new AbortController();
    const pending = executeRun(workerDeps(t.ctx, query), run.id, controller.signal);
    await running.promise;
    controller.abort();
    expect((await pending).outcome).toBe('cancelled');
    expect(interrupts).toBe(1);
    // The graceful path was taken: the CLI was not killed.
    expect(sdkAbort?.signal.aborted).toBe(false);
    const row = await getRun(t.ctx, run.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.costUsd).toBeCloseTo(0.07, 6);
    expect(row?.payload.usageTotals).toMatchObject({ sdkSessionId: 'sess-i' });
    const usage = await t.ctx.db.select().from(runModelUsage).where(eq(runModelUsage.runId, run.id));
    expect(usage.reduce((s, u) => s + u.costUsd, 0)).toBeCloseTo(0.07, 6);
    expect(usage[0]?.inputTokens).toBe(700);
  });

  it('an owner cancellation (no shutdown reason) still cancels the run', async () => {
    const { run } = await dmRun('Longue tâche');
    const { query, running } = stoppableQuery('sess-y');
    const controller = new AbortController();
    const pending = executeRun(workerDeps(t.ctx, query), run.id, controller.signal);
    await running;
    controller.abort();
    expect((await pending).outcome).toBe('cancelled');
    expect((await getRun(t.ctx, run.id))?.status).toBe('cancelled');
  });

  it('saves the SDK session as soon as it starts, so a crash resumes it instead of replaying the request', async () => {
    const { bot, run } = await dmRun('Lance la migration');
    const started = deferred();
    const hanging = ((params: { prompt: string }) =>
      (async function* (): AsyncGenerator<SDKMessage> {
        void params;
        yield sdk.init('sess-k');
        yield sdk.delta('Étape 1 faite', 'sess-k');
        started.resolve();
        // The worker process dies here: this turn never ends.
        await new Promise(() => undefined);
      })()) as unknown as QueryFn;
    void executeRun(workerDeps(t.ctx, hanging), run.id, signal());
    await started.promise;
    const session = await t.ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.botId, bot.id) });
    expect(session?.sdkSessionId).toBe('sess-k');
    expect((await getRun(t.ctx, run.id))?.sdkSessionId).toBe('sess-k');

    // The job is replayed by the next worker.
    const next = fakeQuery(async function* () {
      yield sdk.init('sess-k');
      yield sdk.assistant('Migration reprise et terminée.', 'sess-k');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-k');
    });
    expect((await executeRun(workerDeps(t.ctx, next.query), run.id, signal())).outcome).toBe('done');
    expect(next.calls[0]!.options.resume).toBe('sess-k');
    expect(next.calls[0]!.prompt).toContain('Ant a redémarré pendant ta tâche');
    const bubbles = await t.ctx.db.select().from(messages).where(and(eq(messages.runId, run.id), eq(messages.authorKind, 'bot')));
    expect(bubbles.some((m) => m.status === 'streaming')).toBe(false);
    expect(bubbles.some((m) => m.content.includes('Migration reprise'))).toBe(true);
  });

  it('keeps the session after a startup crash; only a missing transcript starts a fresh session, with the history', async () => {
    const { bot, run } = await dmRun('Mon chat s’appelle Gribouille');
    const first = fakeQuery(async function* () {
      yield sdk.init('sess-r');
      yield sdk.assistant('Noté, Gribouille !', 'sess-r');
      yield sdk.result('Noté, Gribouille !', 0.01, 'claude-sonnet-5-5', 'sess-r');
    });
    await executeRun(workerDeps(t.ctx, first.query), run.id, signal());

    const run2 = await nextDmRun(bot.dmChannelId, 'Comment s’appelle mon chat ?');
    const crash = fakeQuery(async function* () {
      yield sdk.init('sess-r');
      throw new Error('Claude Code process terminated by signal SIGKILL');
    });
    expect((await executeRun(workerDeps(t.ctx, crash.query), run2.id, signal())).outcome).toBe('error');
    expect(crash.calls).toHaveLength(1);
    const kept = await t.ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.botId, bot.id) });
    expect(kept?.sdkSessionId).toBe('sess-r');

    const run3 = await nextDmRun(bot.dmChannelId, 'Et maintenant ?');
    const lost = fakeQuery(async function* (_call, index) {
      if (index === 0) throw new Error('Claude Code returned an error result: No conversation found with session ID: sess-r');
      yield sdk.init('sess-new');
      yield sdk.assistant('Il s’appelle Gribouille.', 'sess-new');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-new');
    });
    expect((await executeRun(workerDeps(t.ctx, lost.query), run3.id, signal())).outcome).toBe('done');
    expect(lost.calls[0]!.options.resume).toBe('sess-r');
    expect(lost.calls[1]!.options.resume).toBeUndefined();
    const prompt = lost.calls[1]!.prompt;
    expect(prompt).toContain('ta session précédente n’a pas pu être reprise');
    expect(prompt).toContain('Mon chat s’appelle Gribouille');
    expect(prompt).toContain('Noté, Gribouille !');
    expect(prompt).toContain('Message du propriétaire :\nEt maintenant ?');
    const fresh = await t.ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.botId, bot.id) });
    expect(fresh?.sdkSessionId).toBe('sess-new');
  });

  it('drops a session whose resume fails before any answer in two runs in a row', async () => {
    const { bot, run } = await dmRun('Mon chat s’appelle Gribouille');
    const ok = fakeQuery(async function* () {
      yield sdk.init('sess-b');
      yield sdk.assistant('Noté, Gribouille !', 'sess-b');
      yield sdk.result('Noté, Gribouille !', 0.01, 'claude-sonnet-5-5', 'sess-b');
    });
    await executeRun(workerDeps(t.ctx, ok.query), run.id, signal());

    // The API rejects the resumed transcript.
    const run2 = await nextDmRun(bot.dmChannelId, 'Deux');
    const rejected = fakeQuery(async function* () {
      yield sdk.init('sess-b');
      yield sdk.assistant('', 'sess-b', 'invalid_request');
      yield sdk.result('', 0, 'claude-sonnet-5-5', 'sess-b');
    });
    expect((await executeRun(workerDeps(t.ctx, rejected.query), run2.id, signal())).outcome).toBe('error');
    expect((await t.ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.botId, bot.id) }))?.sdkSessionId).toBe('sess-b');

    // The CLI cannot load it either: second run in a row, the session is dropped and the request answered.
    const run3 = await nextDmRun(bot.dmChannelId, 'Comment s’appelle mon chat ?');
    const broken = fakeQuery(async function* (_call, index) {
      if (index === 0) throw new Error('Claude Code process exited with code 1');
      yield sdk.init('sess-b2');
      yield sdk.assistant('Il s’appelle Gribouille.', 'sess-b2');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-b2');
    });
    expect((await executeRun(workerDeps(t.ctx, broken.query), run3.id, signal())).outcome).toBe('done');
    expect(broken.calls[0]!.options.resume).toBe('sess-b');
    expect(broken.calls[1]!.options.resume).toBeUndefined();
    expect(broken.calls[1]!.prompt).toContain('ta session précédente n’a pas pu être reprise');
    expect(broken.calls[1]!.prompt).toContain('Noté, Gribouille !');
    expect(broken.calls[1]!.prompt).toContain('Message du propriétaire :\nComment s’appelle mon chat ?');
    expect((await t.ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.botId, bot.id) }))?.sdkSessionId).toBe('sess-b2');
  });

  it('keeps the session after isolated or transient resume failures', async () => {
    const { bot, run } = await dmRun('Un');
    const ok = fakeQuery(async function* () {
      yield sdk.init('sess-t');
      yield sdk.assistant('ok', 'sess-t');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-t');
    });
    const crash = fakeQuery(async function* () {
      throw new Error('Claude Code process exited with code 1');
    });
    const overloaded = fakeQuery(async function* () {
      yield sdk.init('sess-t');
      yield sdk.assistant('', 'sess-t', 'overloaded');
      yield sdk.result('', 0, 'claude-sonnet-5-5', 'sess-t');
    });
    await executeRun(workerDeps(t.ctx, ok.query), run.id, signal());
    // An overloaded API says nothing about the session; a crash after it is the first real failure.
    for (const q of [overloaded, crash, ok, crash]) {
      const r = await nextDmRun(bot.dmChannelId, 'Encore');
      await executeRun(workerDeps(t.ctx, q.query), r.id, signal());
    }
    expect(crash.calls).toHaveLength(2);
    expect(crash.calls.every((c) => c.options.resume === 'sess-t')).toBe(true);
    expect(ok.calls[1]!.options.resume).toBe('sess-t');
    expect((await t.ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.botId, bot.id) }))?.sdkSessionId).toBe('sess-t');
  });

  it('after a switch, a heartbeat resumes its own session and a lost session replays the original request', async () => {
    await updateSettings(t.ctx.db, { computeMode: 'subscription_then_api' });
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    const hb = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      threadKey: `heartbeat:${bot.id}`,
      trigger: 'heartbeat',
      priority: 'background',
      origin: 'autonomous',
      prompt: 'Heartbeat : PISTES XYZ',
    });
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const hbQuery = fakeQuery(async function* (_call, index) {
      if (index === 0) {
        yield sdk.init('sess-h');
        yield sdk.rateLimit('rejected', { rateLimitType: 'five_hour', resetsAt, utilization: 1 }, 'sess-h');
        return;
      }
      yield sdk.assistant('Rien à signaler.', 'sess-h');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-h');
    });
    expect((await executeRun(workerDeps(t.ctx, hbQuery.query), hb!.id, signal())).outcome).toBe('done');
    expect(hbQuery.calls[0]!.options.resume).toBeUndefined();
    expect(hbQuery.calls[0]!.prompt).toContain('PISTES XYZ');
    expect(hbQuery.calls[1]!.options.resume).toBe('sess-h');
    expect(hbQuery.calls[1]!.prompt).toContain('changement de source de calcul');

    // The subscription is available again for the owner's message.
    await patchComputeState(t.ctx, { subLimitedUntil: null, subFiveHourUtil: null, subFiveHourResetsAt: null });
    const dm = await nextDmRun(bot.dmChannelId, 'TACHE ORIGINALE');
    const dmQuery = fakeQuery(async function* (_call, index) {
      if (index === 0) {
        yield sdk.init('sess-d');
        yield sdk.rateLimit('rejected', { rateLimitType: 'five_hour', resetsAt, utilization: 1 }, 'sess-d');
        return;
      }
      if (index === 1) throw new Error('Claude Code returned an error result: No conversation found with session ID: sess-d');
      yield sdk.init('sess-n');
      yield sdk.assistant('Fait.', 'sess-n');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-n');
    });
    expect((await executeRun(workerDeps(t.ctx, dmQuery.query), dm.id, signal())).outcome).toBe('done');
    expect(dmQuery.calls[1]!.options.resume).toBe('sess-d');
    expect(dmQuery.calls[1]!.prompt).toContain('Reprends exactement là où tu en étais');
    expect(dmQuery.calls[2]!.options.resume).toBeUndefined();
    expect(dmQuery.calls[2]!.prompt).toContain('TACHE ORIGINALE');
    expect(dmQuery.calls[2]!.prompt).not.toContain('Reprends exactement');
  });

  it('pauses instead of reporting an empty success when switches use up the attempts', async () => {
    await updateSettings(t.ctx.db, { computeMode: 'subscription_then_api' });
    const { bot, run } = await dmRun('Un');
    const first = fakeQuery(async function* () {
      yield sdk.init('sess-r');
      yield sdk.assistant('Un.', 'sess-r');
      yield sdk.result('Un.', 0.01, 'claude-sonnet-5-5', 'sess-r');
    });
    await executeRun(workerDeps(t.ctx, first.query), run.id, signal());
    const run2 = await nextDmRun(bot.dmChannelId, 'Deux');
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const { query, calls } = fakeQuery(async function* (_call, index) {
      if (index === 0) throw new Error('Claude Code returned an error result: No conversation found with session ID: sess-r');
      if (index === 1) {
        yield sdk.init('sess-n');
        yield sdk.rateLimit('rejected', { rateLimitType: 'five_hour', resetsAt, utilization: 1 }, 'sess-n');
        return;
      }
      yield sdk.assistant('', 'sess-n', 'billing_error');
      yield sdk.result('', 0, 'claude-sonnet-5-5', 'sess-n');
    });
    const res = await executeRun(workerDeps(t.ctx, query), run2.id, signal());
    expect(calls).toHaveLength(3);
    expect(res.outcome).toBe('deferred');
    expect((await getRun(t.ctx, run2.id))?.status).toBe('paused');
    const all = await t.ctx.db.select().from(messages);
    expect(all.some((m) => m.content.includes('_(pas de réponse)_'))).toBe(false);
    expect(all.some((m) => m.status === 'streaming')).toBe(false);
    expect(all.filter((m) => m.authorKind === 'system' && m.content.startsWith('⏸️'))).toHaveLength(1);
  });

  it('honours a cancellation that lands during a compute switch', async () => {
    await updateSettings(t.ctx.db, { computeMode: 'subscription_then_api' });
    const { run } = await dmRun();
    const ext = new AbortController();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.init('sess-c');
      yield sdk.rateLimit('rejected', { rateLimitType: 'five_hour', resetsAt, utilization: 1 }, 'sess-c');
      ext.abort();
      yield sdk.result('', 0.001, 'claude-sonnet-5-5', 'sess-c');
    });
    const res = await executeRun(workerDeps(t.ctx, query), run.id, ext.signal);
    expect(res.outcome).toBe('cancelled');
    expect(calls).toHaveLength(1);
    expect((await getRun(t.ctx, run.id))?.status).toBe('cancelled');
  });

  it('keeps the text of the first attempt in the message while the next attempt streams', async () => {
    await updateSettings(t.ctx.db, { computeMode: 'subscription_then_api' });
    const { bot, run } = await dmRun();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    let during = '';
    const { query } = fakeQuery(async function* (_call, index) {
      if (index === 0) {
        yield sdk.init('sess-s');
        yield sdk.delta('Je commence', 'sess-s');
        yield sdk.rateLimit('rejected', { rateLimitType: 'five_hour', resetsAt, utilization: 1 }, 'sess-s');
        return;
      }
      const live = await t.ctx.db.query.messages.findFirst({ where: and(eq(messages.botId, bot.id), eq(messages.status, 'streaming')) });
      during = live?.content ?? '';
      yield sdk.delta('Reprise', 'sess-s');
      yield sdk.assistant('Reprise', 'sess-s');
      yield sdk.result('Reprise', 0.01, 'claude-sonnet-5-5', 'sess-s');
    });
    await executeRun(workerDeps(t.ctx, query), run.id, signal());
    expect(during).toBe('Je commence\n\n');
    const reply = await t.ctx.db.query.messages.findFirst({ where: and(eq(messages.runId, run.id), eq(messages.authorKind, 'bot')) });
    expect(reply?.content).toBe('Je commence\n\nReprise');
  });

  // ─────────────── What the bot sees ───────────────

  it('shows a bot what others posted while it was running, including replies that were still streaming', async () => {
    const chef = await createBot(t.ctx, { name: 'Chef', role: 'coordination' });
    const dev = await createBot(t.ctx, { name: 'Dev', role: 'développement' });
    const channel = await createGroupChannel(t.ctx, { name: 'projet', botIds: [chef.id, dev.id] });
    const msg = await createMessage(t.ctx, { channelId: channel.id, authorKind: 'user', content: '@chef et @dev : faites le point' });
    const [chefRun] = (await dispatchUserMessage(t.ctx, msg)).filter((r) => r.botId === chef.id);
    // Dev's run has already created its streaming placeholder when Chef reads the conversation.
    const devReply = await createMessage(t.ctx, { channelId: channel.id, authorKind: 'bot', botId: dev.id, content: '', status: 'streaming' });
    const { query, calls } = fakeQuery(async function* (_call, index) {
      if (index === 0) {
        await updateMessage(t.ctx, devReply.id, { content: 'DEV-REPONSE : le build est cassé', status: 'done' });
        await createMessage(t.ctx, { channelId: channel.id, authorKind: 'user', content: '@dev regarde le serveur' });
      }
      yield sdk.init('sess-chef');
      yield sdk.assistant('Point fait.', 'sess-chef');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-chef');
    });
    await executeRun(workerDeps(t.ctx, query), chefRun!.id, signal());
    const ask = await createMessage(t.ctx, { channelId: channel.id, authorKind: 'user', content: '@chef que dit dev ?' });
    const [chefRun2] = await dispatchUserMessage(t.ctx, ask);
    await executeRun(workerDeps(t.ctx, query), chefRun2!.id, signal());
    expect(calls[1]!.prompt).toContain('DEV-REPONSE');
    expect(calls[1]!.prompt).toContain('@dev regarde le serveur');
    expect(calls[1]!.prompt).not.toContain('Point fait.');
  });

  it('keeps the most recent unseen messages when there are too many', async () => {
    const chef = await createBot(t.ctx, { name: 'Chef', role: 'coordination' });
    const dev = await createBot(t.ctx, { name: 'Dev', role: 'développement' });
    const channel = await createGroupChannel(t.ctx, { name: 'bavard', botIds: [chef.id, dev.id] });
    await t.ctx.db.insert(agentSessions).values({ botId: chef.id, threadKey: channel.id, sdkSessionId: 'sess-old', lastSeenAt: new Date(Date.now() - 60_000) });
    for (let i = 1; i <= 60; i++) {
      await createMessage(t.ctx, { channelId: channel.id, authorKind: 'bot', botId: dev.id, content: `message numéro ${i} fin` });
    }
    const ask = await createMessage(t.ctx, { channelId: channel.id, authorKind: 'user', content: '@chef résume' });
    const [run] = await dispatchUserMessage(t.ctx, ask);
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.assistant('ok', 'sess-old');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-old');
    });
    await executeRun(workerDeps(t.ctx, query), run!.id, signal());
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('message numéro 60 fin');
    expect(prompt).toContain('message numéro 21 fin');
    expect(prompt).not.toContain('message numéro 1 fin');
    expect(prompt).toContain('messages plus anciens omis');
    expect(prompt.indexOf('numéro 59 fin')).toBeLessThan(prompt.indexOf('numéro 60 fin'));
  });

  it('shows the bot its own nudges and digest when the owner answers them in the DM', async () => {
    const { bot, run } = await dmRun('Salut');
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.init('sess-a');
      yield sdk.assistant('Bonjour, je suis là.', 'sess-a');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-a');
    });
    await executeRun(workerDeps(t.ctx, query), run.id, signal());
    const hb = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      threadKey: `heartbeat:${bot.id}`,
      trigger: 'heartbeat',
      priority: 'background',
      origin: 'autonomous',
      prompt: 'hb',
    });
    await createMessage(t.ctx, {
      channelId: bot.dmChannelId,
      authorKind: 'bot',
      botId: bot.id,
      content: '**💡 Idée — Relancer le thread Kozmo sur X**\n\nLe fil est retombé depuis lundi.',
      meta: { kind: 'nudge', runId: hb!.id },
    });
    await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'bot', botId: bot.id, content: '**Résumé du jour**\n\nRIEN-D-URGENT', meta: { kind: 'digest' } });
    const reply = await nextDmRun(bot.dmChannelId, 'Oui, vas-y');
    await executeRun(workerDeps(t.ctx, query), reply.id, signal());
    const prompt = calls[1]!.prompt;
    expect(prompt).toContain('Relancer le thread Kozmo');
    expect(prompt).toContain('relance proactive');
    expect(prompt).toContain('RIEN-D-URGENT');
    // Its own reply of the previous run is already in its session.
    expect(prompt).not.toContain('Bonjour, je suis là.');
    expect(prompt).toContain('Message du propriétaire :\nOui, vas-y');
  });

  it('gives the first run of a DM the nudges posted before it', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'bot', botId: bot.id, content: '**⚠️ Risque — Contrat à renouveler**\n\nIl expire vendredi.', meta: { kind: 'nudge' } });
    const run = await nextDmRun(bot.dmChannelId, 'Oui, prépare-le');
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.init('sess-f');
      yield sdk.assistant('ok', 'sess-f');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-f');
    });
    await executeRun(workerDeps(t.ctx, query), run.id, signal());
    expect(calls[0]!.prompt).toContain('Contrat à renouveler');
    expect(calls[0]!.prompt.match(/Oui, prépare-le/g)).toHaveLength(1);
  });

  // ─────────────── Hand-offs, step limit, rotation ───────────────

  it('does not hand off twice when the bot used the handoff tool and then names the same bot', async () => {
    const chef = await createBot(t.ctx, { name: 'Chef', role: 'coordination' });
    const dev = await createBot(t.ctx, { name: 'Dev', role: 'développement' });
    const channel = await createGroupChannel(t.ctx, { name: 'projet', botIds: [chef.id, dev.id] });
    const msg = await createMessage(t.ctx, { channelId: channel.id, authorKind: 'user', content: '@chef organise le travail' });
    const [run] = await dispatchUserMessage(t.ctx, msg);
    const { query } = fakeQuery(async function* (call) {
      const server = (call.options.mcpServers as Record<string, { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }>).ant!;
      await server.instance._registeredTools.handoff!.handler({ bot: 'dev', task: 'corrige le bug de connexion' }, {});
      yield sdk.assistant('J’ai confié la correction du bug à @dev.');
      yield sdk.result('', 0.01);
    });
    await executeRun(workerDeps(t.ctx, query), run!.id, signal());
    const devRuns = await t.ctx.db.select().from(runs).where(and(eq(runs.botId, dev.id), eq(runs.trigger, 'handoff')));
    expect(devRuns).toHaveLength(1);
    expect(devRuns[0]!.prompt).toContain('corrige le bug de connexion');
    expect(await t.ctx.db.select().from(handoffs)).toHaveLength(1);
  });

  it('continues a long task in a follow-up run when the step limit is reached (at most twice)', async () => {
    const { bot, run } = await dmRun('Fais la grosse migration');
    const maxTurns = fakeQuery(async function* () {
      yield sdk.init('sess-m');
      yield sdk.assistant('Étapes 1 à 40 faites.', 'sess-m');
      yield resultWith('sess-m', { cost: 0.5, input: 5000, output: 500 }, { subtype: 'error_max_turns', is_error: true, errors: [] });
    });
    expect((await executeRun(workerDeps(t.ctx, maxTurns.query), run.id, signal())).outcome).toBe('done');
    const reply = await t.ctx.db.query.messages.findFirst({ where: and(eq(messages.runId, run.id), eq(messages.authorKind, 'bot')) });
    expect(reply?.content).toContain('Étapes 1 à 40 faites.');
    expect(reply?.content).toContain('je continue dans une nouvelle exécution');
    const follow = await t.ctx.db.query.runs.findFirst({ where: and(eq(runs.botId, bot.id), eq(runs.trigger, 'system')) });
    const original = await getRun(t.ctx, run.id);
    expect(follow?.payload.continuation).toBe(1);
    expect(follow?.chainId).toBe(original?.chainId);
    expect(follow?.threadKey).toBe(original?.threadKey);
    const job = await t.ctx.db.select().from(jobs).where(eq(jobs.kind, 'bot.run'));
    expect(job.some((j) => j.payload.runId === follow!.id && j.lane === `run:${bot.id}:${original!.threadKey}`)).toBe(true);

    const cont = fakeQuery(async function* () {
      yield sdk.init('sess-m');
      yield sdk.assistant('Migration terminée.', 'sess-m');
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-m');
    });
    expect((await executeRun(workerDeps(t.ctx, cont.query), follow!.id, signal())).outcome).toBe('done');
    expect(cont.calls[0]!.options.resume).toBe('sess-m');
    expect(cont.calls[0]!.prompt).toContain('Suite automatique');
    expect(cont.calls[0]!.prompt).toContain('suite automatique d’une tâche longue');

    // After two follow-ups, the step limit ends the run with an error.
    const last = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      trigger: 'system',
      priority: 'interactive',
      origin: 'user',
      prompt: 'Suite',
      payload: { continuation: 2 },
    });
    expect((await executeRun(workerDeps(t.ctx, maxTurns.query), last!.id, signal())).outcome).toBe('error');
    expect((await getRun(t.ctx, last!.id))?.error).toContain('prolongations automatiques');
    expect(await t.ctx.db.select().from(runs).where(and(eq(runs.botId, bot.id), eq(runs.trigger, 'system')))).toHaveLength(2);
  });

  it('can retry a rotation after an earlier one finished without rotating, with the origin of the run', async () => {
    await updateSettings(t.ctx.db, { sessionRotateTokens: 20_000 });
    const { bot, run } = await dmRun('Un');
    const big = sdk.assistant('ok', 'sess-o') as unknown as { message: { usage: Record<string, number> } };
    big.message.usage.input_tokens = 30_000;
    const { query } = fakeQuery(async function* () {
      yield sdk.init('sess-o');
      yield big as unknown as SDKMessage;
      yield sdk.result('ok', 0.01, 'claude-sonnet-5-5', 'sess-o');
    });
    await executeRun(workerDeps(t.ctx, query), run.id, signal());
    const session = (await t.ctx.db.query.agentSessions.findFirst({ where: eq(agentSessions.botId, bot.id) }))!;
    // An earlier rotation job finished without rotating (summary paused): it must not block the next one for days.
    await t.ctx.db.delete(jobs).where(eq(jobs.kind, 'session.rotate'));
    await t.ctx.db.insert(jobs).values({ kind: 'session.rotate', payload: { sessionId: session.id }, status: 'done', dedupeKey: `rotate:${session.id}` });
    const run2 = await nextDmRun(bot.dmChannelId, 'Deux');
    await executeRun(workerDeps(t.ctx, query), run2.id, signal());
    const rotations = await t.ctx.db.select().from(jobs).where(and(eq(jobs.kind, 'session.rotate'), eq(jobs.status, 'pending')));
    expect(rotations).toHaveLength(1);
    expect(rotations[0]!.payload).toMatchObject({ sessionId: session.id, origin: 'user' });
    expect(rotations[0]!.maxAttempts).toBe(1);
  });

  it('browser tool: on a sensitive site, send shortcuts and Space need approval, Tab does not', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'x' });
    const executed: unknown[] = [];
    const computer = stubComputer({
      browser: async (req: { action: string }) => {
        if (req.action !== 'screenshot') executed.push(req);
        return { ok: true, url: 'https://x.com/compose/post', title: 'X' };
      },
      inspect: async () => ({ url: 'https://x.com/compose/post', title: 'X', elementLabel: 'Poster' }),
    });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer });
    const rc: RunContext = {
      deps,
      settings: DEFAULT_SETTINGS,
      run: (await getRun(t.ctx, run!.id))!,
      bot: (await t.ctx.db.query.bots.findFirst())!,
      permissions: DEFAULT_BOT_PERMISSIONS,
      channel: null,
      computeSource: 'subscription',
      pendingApprovals: [],
      botsBySlug: new Map(),
      setActivity: async () => undefined,
    };
    const browser = antTools(rc).find((x) => x.name === 'browser')!.handler as (a: Record<string, unknown>, e: unknown) => Promise<unknown>;
    expect(JSON.stringify(await browser({ action: 'press', key: 'Control+Enter' }, {}))).toContain('validation');
    expect(JSON.stringify(await browser({ action: 'press', key: 'Space', ref: 'e12' }, {}))).toContain('validation');
    await browser({ action: 'press', key: 'Tab' }, {});
    expect(executed).toEqual([expect.objectContaining({ action: 'press', key: 'Tab' })]);
    const pending = await t.ctx.db.select().from(approvals);
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.summary.split('\n')[0]).sort()).toEqual([
      'Appuyer sur la touche « Espace » dans « Poster » — https://x.com/compose/post',
      'Appuyer sur le raccourci « Ctrl+Entrée » — https://x.com/compose/post',
    ]);
  });

  // ─────────────── Paused autonomous work ───────────────

  it('does not report Ant as paused when only autonomous work waits, and drops it after 6 hours', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    const routineRun = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      trigger: 'routine',
      priority: 'background',
      origin: 'autonomous',
      prompt: 'Point hebdo',
    });
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.result('', 0, 'x');
    });
    // Default hybrid mode, no API key: autonomous work cannot run, the owner's own requests can.
    const deps = workerDeps(t.ctx, query, { cfg: { ANTHROPIC_API_KEY: undefined } });
    expect((await executeRun(deps, routineRun!.id, signal())).outcome).toBe('deferred');
    expect(calls).toHaveLength(0);
    expect((await getComputeState(t.ctx)).allPausedReason).toBeFalsy();
    expect(await t.ctx.db.select().from(budgetAlerts).where(eq(budgetAlerts.scope, 'all_paused'))).toHaveLength(0);
    const waiting = await t.ctx.db.select().from(messages).where(eq(messages.authorKind, 'system'));
    expect(waiting.some((m) => m.content.startsWith('⏸️ Tâche autonome en attente'))).toBe(true);

    await t.ctx.db.update(runs).set({ createdAt: new Date(Date.now() - 7 * 3600_000) }).where(eq(runs.id, routineRun!.id));
    expect((await executeRun(deps, routineRun!.id, signal())).outcome).toBe('cancelled');
    const row = await getRun(t.ctx, routineRun!.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.error).toContain('non exécuté');
    // The ⏸️ notice becomes the ⏹️ one: a single message per abandoned occurrence.
    const notes = await t.ctx.db.select().from(messages).where(eq(messages.authorKind, 'system'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toMatch(/^⏹️ Tâche autonome abandonnée après 6 h/);
    const logged = await t.ctx.db.select().from(auditLog).where(and(eq(auditLog.runId, routineRun!.id), eq(auditLog.event, 'run.finished')));
    expect(logged[0]?.outcome).toBe('cancelled');
  });

  it('still posts the ⏹️ notice for autonomous work dropped without an earlier ⏸️ notice', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    const routineRun = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'routine', priority: 'background', origin: 'autonomous', prompt: 'Point hebdo' });
    await t.ctx.db.update(runs).set({ createdAt: new Date(Date.now() - 7 * 3600_000) }).where(eq(runs.id, routineRun!.id));
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { cfg: { ANTHROPIC_API_KEY: undefined } });
    expect((await executeRun(deps, routineRun!.id, signal())).outcome).toBe('cancelled');
    const notes = await t.ctx.db.select().from(messages).where(eq(messages.authorKind, 'system'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content.startsWith('⏹️ Tâche autonome abandonnée')).toBe(true);
  });

  // ─────────────── API budget reservation ───────────────

  it('reserves the API budget of calls in flight so concurrent runs cannot exceed the cap', async () => {
    await updateSettings(t.ctx.db, { computeMode: 'api_only', apiDailyCapUsd: 8, perRunCapUsd: 2 });
    const settings = await getSettings(t.ctx.db);
    const now = new Date();
    await t.ctx.db.insert(runModelUsage).values({ day: localDateKey(now, settings.timezone), month: localMonthKey(now, settings.timezone), model: 'claude-sonnet-5-5', computeSource: 'api', costUsd: 6 });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query);
    const req = { priority: 'interactive' as const, origin: 'user' as const, botId: null, botDailyCapUsd: null };
    const [a, b] = await Promise.all([
      decideCompute(deps, req, settings, undefined, { key: 'call-a' }),
      decideCompute(deps, req, settings, undefined, { key: 'call-b' }),
    ]);
    const granted = [a, b].filter((d) => d.source === 'api');
    const held = [a, b].filter((d) => d.source === 'paused');
    expect(granted).toHaveLength(1);
    expect(granted[0]!.source === 'api' && granted[0]!.maxBudgetUsd).toBe(2);
    expect(held).toHaveLength(1);
    expect(held[0]!.heldByInFlight).toBe(true);
    expect(held[0]!.source === 'paused' && held[0]!.retryAt!.getTime() - Date.now()).toBeLessThanOrEqual(2 * 60_000);
    expect(reservedApiBudget(null).total).toBe(2);

    releaseApiBudget(a.source === 'api' ? 'call-a' : 'call-b');
    const again = await decideCompute(deps, req, settings, undefined, { key: 'call-c', capUsd: 0.5 });
    expect(again.source === 'api' && again.maxBudgetUsd).toBe(0.5);
    releaseApiBudget('call-c');
    expect(reservedApiBudget(null).total).toBe(0);
  });

  it('releases the budget reserved by a run when it ends', async () => {
    await updateSettings(t.ctx.db, { computeMode: 'api_only' });
    const { run } = await dmRun();
    let heldDuring = 0;
    const { query } = fakeQuery(async function* () {
      heldDuring = reservedApiBudget(null).total;
      yield sdk.assistant('ok');
      yield sdk.result('ok', 0.01);
    });
    await executeRun(workerDeps(t.ctx, query), run.id, signal());
    expect(heldDuring).toBe(2);
    expect(reservedApiBudget(null).total).toBe(0);
  });

  // ─────────────── Ghost runs ───────────────

  it('cancels a run left « running » that no worker executes, and closes its message', async () => {
    const { bot, run } = await dmRun();
    await updateRun(t.ctx, run.id, { status: 'running', activity: 'réfléchit' });
    await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'bot', botId: bot.id, content: '', status: 'streaming', runId: run.id });
    // Its job waits for a retry: no AbortController is listening.
    await cancelRun(t.ctx, run.id);
    const row = await getRun(t.ctx, run.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.activity).toBeNull();
    const bubbles = await t.ctx.db.select().from(messages).where(eq(messages.runId, run.id));
    expect(bubbles.every((m) => m.status !== 'streaming')).toBe(true);
    // When the pending job runs, it does nothing.
    const { query, calls } = fakeQuery(async function* () {});
    expect((await executeRun(workerDeps(t.ctx, query), run.id, signal())).outcome).toBe('cancelled');
    expect(calls).toHaveLength(0);
  });

  it('closes runs whose job is gone, and records a definitive failure', async () => {
    const { bot, run } = await dmRun();
    await updateRun(t.ctx, run.id, { status: 'running', activity: 'réfléchit' });
    await t.ctx.db.update(runs).set({ createdAt: new Date(Date.now() - 10 * 60_000) }).where(eq(runs.id, run.id));
    await t.ctx.db.update(jobs).set({ status: 'failed' }).where(eq(jobs.kind, 'bot.run'));
    const young = await nextDmRun(bot.dmChannelId, 'Tout juste demandé');
    await t.ctx.db.delete(jobs).where(eq(jobs.kind, 'bot.run'));
    expect(await sweepOrphanRuns(t.ctx)).toBe(1);
    expect((await getRun(t.ctx, run.id))?.status).toBe('error');
    // Within the grace period a run may not have its job yet.
    expect((await getRun(t.ctx, young.id))?.status).toBe('queued');

    const other = await nextDmRun(bot.dmChannelId, 'Encore');
    await updateRun(t.ctx, other.id, { status: 'running', activity: 'réfléchit' });
    await failRun(t.ctx, other.id, 'Error: connexion à la base perdue\n    at stack');
    const failed = await getRun(t.ctx, other.id);
    expect(failed?.status).toBe('error');
    expect(failed?.activity).toBeNull();
    expect(failed?.error).toContain('connexion à la base perdue');
    // Never overwrites a finished run.
    await failRun(t.ctx, run.id, 'autre');
    expect((await getRun(t.ctx, run.id))?.error).not.toContain('autre');
  });

  it('worker: a bot.run job that fails for good closes its run; maintenance is queued at start-up', async () => {
    const bot = await createBot(t.ctx, { name: 'Chef', role: 'c', heartbeatEnabled: false });
    // A thread that does not exist: creating the reply placeholder throws inside executeRun.
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: randomUUID(), trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'x' });
    await t.ctx.db.update(jobs).set({ maxAttempts: 1 }).where(eq(jobs.kind, 'bot.run'));
    const { query } = fakeQuery(async function* () {
      yield sdk.result('', 0, 'claude-haiku-5-5', 's', {});
    });
    const handle = await startWorker(workerConfig({ DATABASE_URL: t.url }), { query, migrate: false });
    try {
      await waitFor(async () => (await getRun(t.ctx, run!.id))?.status === 'error', 15_000);
    } finally {
      await handle.stop();
    }
    const row = await getRun(t.ctx, run!.id);
    expect(row?.activity).toBeNull();
    expect(row?.error).toContain('Erreur interne');
    expect(await t.ctx.db.select().from(messages).where(eq(messages.status, 'streaming'))).toHaveLength(0);
    const maint = await t.ctx.db.select().from(jobs).where(eq(jobs.kind, 'maintenance'));
    expect(maint).toHaveLength(1);
    expect(maint[0]!.dedupeKey).toMatch(/^maint:\d+$/);
  });
});
