import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_SETTINGS, TRIAGE_EFFORT, TRIAGE_MODEL, isSilentNothing } from '@ant/shared';
import { agentSessions, bots, jobs, messages, routines, runs } from '../src/db/schema';
import { getSettings, updateSettings } from '../src/lib/settings';
import { createBot } from '../src/services/bots';
import { archiveChannel, createGroupChannel } from '../src/services/channels';
import { createMessage } from '../src/services/messages';
import { forecastMonthUsd, patchComputeState } from '../src/services/quota';
import { createRoutine } from '../src/services/routines';
import {
  cancelRun,
  chainStartedAt,
  effectiveTrigger,
  failRun,
  getRun,
  patchRunPayload,
  requestRun,
  resolveMessageTargets,
  sweepOrphanRuns,
  type RunRow,
} from '../src/services/runs';
import { WEB_MODULES, registerModuleRoutes, startWebModules, type WebModule } from '../src/web/modules';
import { WORKER_MODULES, moduleBuildPrompt, moduleDescribeTrigger, moduleSystemPromptSections, moduleToolActivity, moduleTools, type FinishedRun, type WorkerModule } from '../src/worker/modules';
import { oneShot } from '../src/worker/oneshot';
import { parseThreadKey, rotateSession } from '../src/worker/rotate';
import type { RunContext } from '../src/worker/run-context';
import { afterRunClosed, executeRun } from '../src/worker/runner';
import { schedulerTick } from '../src/worker/scheduler';
import { createTestDb, databaseAvailable, fakeQuery, sdk, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();
const signal = () => new AbortController().signal;

describe('effective trigger and duration of a continued task', () => {
  const base = { startedAt: new Date('2026-10-13T08:10:00Z'), createdAt: new Date('2026-10-13T08:09:00Z') };
  it('uses the trigger and the first start of the run a continuation continues', () => {
    expect(effectiveTrigger({ trigger: 'routine', payload: {} })).toBe('routine');
    expect(effectiveTrigger({ trigger: 'system', payload: { continuedTrigger: 'followup' } })).toBe('followup');
    expect(effectiveTrigger({ trigger: 'system', payload: { continuedTrigger: 'rotate' } })).toBe('system');
    expect(effectiveTrigger({ trigger: 'system', payload: { continuedTrigger: 'constructor' } })).toBe('system');
    expect(chainStartedAt({ ...base, payload: {} })).toEqual(base.startedAt);
    expect(chainStartedAt({ ...base, startedAt: null, payload: {} })).toEqual(base.createdAt);
    expect(chainStartedAt({ ...base, payload: { chainStartedAt: '2026-10-13T08:00:00.000Z' } })).toEqual(new Date('2026-10-13T08:00:00Z'));
    expect(chainStartedAt({ ...base, payload: { chainStartedAt: 'hier' } })).toEqual(base.startedAt);
  });
});

describe('silent answers', () => {
  it('recognise RIEN whatever the case, spaces, punctuation or Markdown', () => {
    for (const text of ['RIEN', 'Rien.', ' rien ! ', '**RIEN**', '« Rien »', '`RIEN`']) expect(isSilentNothing(text)).toBe(true);
    for (const text of ['', 'Rien à signaler', 'Rien de neuf', 'RIEN\n\nSauf une chose', 'Bien']) expect(isSilentNothing(text)).toBe(false);
  });
});

describe('monthly projection', () => {
  it('counts at least three days, so that an expensive first hour does not project a whole month of it', () => {
    // 1 October 01:00 in Zurich: $2 spent → 2 / 3 × 31, not 2 / (1/24) × 31.
    expect(forecastMonthUsd(2, 'Europe/Zurich', new Date('2026-09-30T23:00:00Z'))).toBe(20.67);
    expect(forecastMonthUsd(29, 'Europe/Zurich', new Date('2026-10-15T10:00:00Z'))).toBe(62);
  });
});

describe('thread keys of sessions of their own', () => {
  it('summarises watch sessions and other prefixed sessions from their runs, not as an empty conversation', () => {
    const channel = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseThreadKey(`watch:${channel}`).kind).toBe('watch');
    expect(parseThreadKey(`draft:${channel}`).kind).toBe('runs');
    expect(parseThreadKey(channel)).toEqual({ kind: 'conversation', channelId: channel, threadRootId: null });
    expect(parseThreadKey(`${channel}:${channel}`)).toEqual({ kind: 'conversation', channelId: channel, threadRootId: channel });
    expect(parseThreadKey('none').channelId).toBeNull();
  });
});

describe('isolation of the feature modules', () => {
  const run = { id: 'r', trigger: 'followup', payload: {} } as unknown as RunRow;
  const broken: WorkerModule = {
    name: 'broken',
    tools: () => {
      throw new Error('boum');
    },
    systemPromptSection: () => {
      throw new Error('boum');
    },
    describeTrigger: () => {
      throw new Error('boum');
    },
    buildPrompt: () => {
      throw new Error('boum');
    },
    get toolActivity(): Record<string, string> {
      throw new Error('boum');
    },
  };
  const fine: WorkerModule = {
    name: 'fine',
    tools: () => [{ name: 'ok_tool' } as never],
    systemPromptSection: () => '# Fine',
    describeTrigger: () => 'suivi',
    buildPrompt: (_r, head) => `${head}suivi`,
    toolActivity: { ok_tool: 'travaille' },
  };

  it('keeps one module’s synchronous bug out of every run (worker)', () => {
    expect(moduleTools({} as RunContext, [broken, fine]).map((t) => t.name)).toEqual(['ok_tool']);
    expect(moduleSystemPromptSections({} as never, {} as never, [broken, fine])).toEqual(['# Fine']);
    expect(moduleDescribeTrigger(run, [broken, fine])).toBe('suivi');
    expect(moduleBuildPrompt(run, 'tête ', [broken, fine])).toBe('tête suivi');
    expect(moduleToolActivity('ok_tool', [broken, fine])).toBe('travaille');
  });

  it('starts the web service even when a module fails to register its routes or to start', async () => {
    const started: string[] = [];
    const failing: WebModule = {
      name: 'failing',
      routes: async () => {
        throw new Error('boum');
      },
      onStart: async () => {
        throw new Error('boum');
      },
    };
    const next: WebModule = {
      name: 'next',
      routes: async (app) => {
        app.get('/api/essai', async () => ({ ok: true }));
      },
      onStart: async () => {
        started.push('next');
        return async () => void started.push('stopped');
      },
    };
    const routes: string[] = [];
    const app = { get: (path: string) => void routes.push(path) } as never;
    await registerModuleRoutes(app, {} as never, [failing, next]);
    expect(routes).toEqual(['/api/essai']);
    const stop = await startWebModules({} as never, {} as never, [failing, next]);
    expect(started).toEqual(['next']);
    await stop();
    expect(started).toEqual(['next', 'stopped']);
    expect(WEB_MODULES).toHaveLength(4);
  });
});

describe.skipIf(!hasDb)('foundation after review (database)', () => {
  let t: TestDb;
  const finished: FinishedRun[] = [];
  const tracking = WORKER_MODULES[0]!;
  const capabilities = WORKER_MODULES[3]!;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate runs, run_model_usage, messages, jobs, agent_sessions, approvals, channel_members, channels, bots, routines, compute_state, budget_alerts, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
    await updateSettings(t.ctx.db, { quietHours: null, digestEnabled: false });
    finished.length = 0;
    tracking.afterRun = async (_deps, _settings, f) => void finished.push(f);
  });
  afterEach(() => {
    delete tracking.afterRun;
    delete capabilities.silentRun;
    delete capabilities.tools;
  });

  const answer = (text: string, session = 'sess-r') =>
    fakeQuery(async function* () {
      yield sdk.init(session);
      yield sdk.assistant(text, session);
      yield sdk.result(text, 0.01, 'claude-sonnet-5-5', session);
    });
  const stepLimit = (session = 'sess-r') =>
    fakeQuery(async function* () {
      yield sdk.init(session);
      const result = sdk.result('', 0.02, 'claude-sonnet-5-5', session) as unknown as Record<string, unknown>;
      yield { ...result, subtype: 'error_max_turns', is_error: true, errors: [] } as unknown as SDKMessage;
    });
  const dmRun = async (bot: { id: string; dmChannelId: string }, extra: Partial<Parameters<typeof requestRun>[1]> = {}) =>
    (await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'Bonjour', ...extra }))!;

  it('tells afterRun the original trigger and the duration of the whole task when its last piece is a continuation', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 8 * * 1', instruction: 'Fais le point' }, 'Europe/Zurich');
    const first = await dmRun(bot, { trigger: 'routine', priority: 'background', origin: 'autonomous', payload: { routineId: routine.id } });
    // The task began ten minutes ago.
    const began = new Date(Date.now() - 10 * 60_000);
    await t.ctx.db.update(runs).set({ startedAt: began }).where(eq(runs.id, first.id));
    await updateSettings(t.ctx.db, { computeMode: 'api_only' });

    await executeRun(workerDeps(t.ctx, stepLimit().query), first.id, signal());
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'done', trigger: 'routine', continued: true });
    const next = (await t.ctx.db.query.runs.findFirst({ where: and(eq(runs.botId, bot.id), eq(runs.trigger, 'system')) }))!;
    expect(next.payload.chainStartedAt).toBe(began.toISOString());

    await executeRun(workerDeps(t.ctx, answer('Point fait.').query), next.id, signal());
    expect(finished).toHaveLength(2);
    const last = finished[1]!;
    expect(last).toMatchObject({ status: 'done', trigger: 'routine', continued: false, finalText: 'Point fait.', silent: false });
    expect(last.run.trigger).toBe('system');
    expect(last.run.status).toBe('done');
    expect(last.startedAt).toEqual(began);
    expect(last.durationMs).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
    expect(last.responseMessageId).toBeTruthy();
    expect((await getRun(t.ctx, next.id))?.payload.afterRunAt).toBeTruthy();
  });

  it('ends the task in afterRun when no continuation can start (bot paused meanwhile)', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    const run = await dmRun(bot);
    const { query } = fakeQuery(async function* () {
      yield sdk.init('sess-p');
      await t.ctx.db.update(bots).set({ paused: true }).where(eq(bots.id, bot.id));
      const result = sdk.result('', 0.02, 'claude-sonnet-5-5', 'sess-p') as unknown as Record<string, unknown>;
      yield { ...result, subtype: 'error_max_turns', is_error: true, errors: [] } as unknown as SDKMessage;
    });
    await executeRun(workerDeps(t.ctx, query), run.id, signal());
    expect(await t.ctx.db.select().from(runs).where(eq(runs.trigger, 'system'))).toHaveLength(0);
    expect(finished[0]).toMatchObject({ status: 'done', continued: false });
  });

  it('tells afterRun that a run was silent, with its answer and the files it attached', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    const file = { path: '/workspace/rapport.pdf', name: 'rapport.pdf', mime: 'application/pdf', size: 1200 };
    capabilities.silentRun = async (_deps, r) => r.trigger === 'watch';
    capabilities.tools = (rc) => {
      rc.outputs.attachments.push(file);
      return [];
    };
    const run = await dmRun(bot, { trigger: 'watch', priority: 'background', origin: 'autonomous', threadKey: 'watch:abc', payload: { watchId: 'abc' } });
    await updateSettings(t.ctx.db, { computeMode: 'api_only' });
    await executeRun(workerDeps(t.ctx, answer('Rien.').query), run.id, signal());
    expect(finished[0]).toMatchObject({ status: 'done', trigger: 'watch', silent: true, responseMessageId: null, finalText: 'Rien.', attachments: [file] });
    expect(await t.ctx.db.select().from(messages).where(eq(messages.authorKind, 'bot'))).toHaveLength(0);
  });

  it('runs afterRun once for a run cancelled while it waited, as soon as the owner cancels it', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    const run = await dmRun(bot, { trigger: 'handoff', priority: 'normal', origin: 'autonomous', payload: { reportTo: { runId: crypto.randomUUID(), botId: bot.id } } });
    // Paused for lack of compute: its job is due much later.
    await t.ctx.db.update(runs).set({ status: 'paused' }).where(eq(runs.id, run.id));
    await t.ctx.db.update(jobs).set({ runAt: new Date(Date.now() + 3 * 3600_000) }).where(eq(jobs.kind, 'bot.run'));
    await cancelRun(t.ctx, run.id);
    const [job] = await t.ctx.db.select().from(jobs).where(eq(jobs.kind, 'bot.run'));
    expect(job!.runAt.getTime()).toBeLessThanOrEqual(Date.now());

    const { query, calls } = answer('x');
    expect((await executeRun(workerDeps(t.ctx, query), run.id, signal())).outcome).toBe('cancelled');
    expect(calls).toHaveLength(0);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'cancelled', trigger: 'handoff', finalText: '', continued: false });
    expect(finished[0]!.run.payload.reportTo).toBeTruthy();
    // Picked up again (job replayed after a crash): not a second time.
    await executeRun(workerDeps(t.ctx, query), run.id, signal());
    expect(finished).toHaveLength(1);
  });

  it('runs afterRun for a run whose bot was paused, or whose conversation was archived, before it started', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    const paused = await dmRun(bot);
    await t.ctx.db.update(bots).set({ paused: true }).where(eq(bots.id, bot.id));
    await executeRun(workerDeps(t.ctx, answer('x').query), paused.id, signal());
    expect(finished[0]).toMatchObject({ status: 'cancelled', error: 'bot en pause ou archivé' });
    await t.ctx.db.update(bots).set({ paused: false }).where(eq(bots.id, bot.id));

    const group = await createGroupChannel(t.ctx, { name: 'Projet', botIds: [bot.id] });
    const run = await requestRun(t.ctx, { botId: bot.id, channelId: group.id, threadRootId: null, trigger: 'mention', priority: 'interactive', origin: 'user', prompt: 'x' });
    await archiveChannel(t.ctx, group.id);
    await executeRun(workerDeps(t.ctx, answer('x').query), run!.id, signal());
    expect(finished[1]).toMatchObject({ status: 'cancelled', trigger: 'mention', channel: null, error: 'conversation archivée' });
  });

  it('does not take a database error for an archived conversation: the run is retried, not cancelled', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    const run = await dmRun(bot);
    const channels = t.ctx.db.query.channels as unknown as { findFirst: (...a: unknown[]) => Promise<unknown> };
    channels.findFirst = async () => {
      throw new Error('Connection terminated unexpectedly');
    };
    try {
      await expect(executeRun(workerDeps(t.ctx, answer('x').query), run.id, signal())).rejects.toThrow(/Connection terminated/);
    } finally {
      delete (channels as { findFirst?: unknown }).findFirst;
    }
    expect((await getRun(t.ctx, run.id))?.status).toBe('queued');
    expect(finished).toHaveLength(0);
    expect(await t.ctx.db.select().from(messages).where(eq(messages.authorKind, 'system'))).toHaveLength(0);
  });

  it('runs afterRun for a run dropped after waiting for compute, a failed job and an orphan run', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    const stale = await dmRun(bot, { trigger: 'routine', priority: 'background', origin: 'autonomous' });
    await t.ctx.db.update(runs).set({ createdAt: new Date(Date.now() - 7 * 3600_000) }).where(eq(runs.id, stale.id));
    const deps = workerDeps(t.ctx, answer('x').query, { cfg: { ANTHROPIC_API_KEY: undefined } });
    expect((await executeRun(deps, stale.id, signal())).outcome).toBe('cancelled');
    expect(finished[0]).toMatchObject({ status: 'cancelled', trigger: 'routine' });

    const failing = await dmRun(bot);
    const closed = await failRun(t.ctx, failing.id, 'Error: boum');
    expect(closed?.status).toBe('error');
    await afterRunClosed(deps, closed!);
    expect(finished[1]).toMatchObject({ status: 'error', trigger: 'user' });
    expect(finished[1]!.error).toContain('Erreur interne');
    expect(await failRun(t.ctx, failing.id, 'encore')).toBeNull();

    const orphan = await dmRun(bot);
    await t.ctx.db.delete(jobs).where(eq(jobs.kind, 'bot.run'));
    await t.ctx.db.update(runs).set({ createdAt: new Date(Date.now() - 10 * 60_000) }).where(eq(runs.id, orphan.id));
    expect(await sweepOrphanRuns(t.ctx, new Date(), undefined, (r) => afterRunClosed(deps, r))).toBe(1);
    expect(finished[2]).toMatchObject({ status: 'error', run: expect.objectContaining({ id: orphan.id }) });
  });

  it('runs afterRun for a scheduled occurrence replaced by a newer one', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'v', heartbeatEnabled: false });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 * * * *', instruction: 'Point' }, 'Europe/Zurich');
    const makeDue = () => t.ctx.db.update(routines).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(routines.id, routine.id));
    const deps = workerDeps(t.ctx, answer('x').query);
    await makeDue();
    await schedulerTick(deps);
    const [first] = await t.ctx.db.select().from(runs).where(eq(runs.trigger, 'routine'));
    await t.ctx.db.update(runs).set({ status: 'paused' }).where(eq(runs.id, first!.id));
    await makeDue();
    await schedulerTick(deps);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'cancelled', trigger: 'routine', run: expect.objectContaining({ id: first!.id }) });
  });

  it('adds the cost of a one-off call made for a run to that run', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    const run = await dmRun(bot);
    const { query } = fakeQuery(async function* () {
      yield sdk.result('', 0.004, TRIAGE_MODEL, 'sess-o', { reponse: 'ok' });
    });
    const settings = await getSettings(t.ctx.db);
    const res = await oneShot(workerDeps(t.ctx, query), settings, {
      label: 'web_extract',
      purpose: 'web_extract',
      runId: run.id,
      model: TRIAGE_MODEL,
      effort: TRIAGE_EFFORT,
      system: 's',
      prompt: 'p',
      schema: { type: 'object' },
      priority: 'interactive',
      origin: 'user',
      botId: bot.id,
    });
    expect(res.ok).toBe(true);
    const row = await getRun(t.ctx, run.id);
    expect(row?.costUsd).toBeCloseTo(0.004, 6);
    expect(row?.inputTokens).toBe(1200);
    // The run's own model calls add to it.
    await executeRun(workerDeps(t.ctx, answer('Fait.').query), run.id, signal());
    expect((await getRun(t.ctx, run.id))?.costUsd).toBeCloseTo(0.014, 6);
  });

  it('summarises a watch session from its runs', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    const run = await dmRun(bot, { trigger: 'watch', priority: 'background', origin: 'autonomous', threadKey: 'watch:w1', prompt: 'Le prix a changé' });
    const reply = await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'bot', botId: bot.id, content: 'Le prix est passé à 42 CHF.', runId: run.id });
    await t.ctx.db.update(runs).set({ status: 'done', responseMessageId: reply.id }).where(eq(runs.id, run.id));
    const [session] = await t.ctx.db.insert(agentSessions).values({ botId: bot.id, threadKey: 'watch:w1', approxTokens: 200_000 }).returning();
    const { query, calls } = fakeQuery(async function* () {
      yield sdk.result('', 0.001, TRIAGE_MODEL, 'sess-s', { summary: 'Prix suivi.' });
    });
    expect(await rotateSession(workerDeps(t.ctx, query), session!.id)).toBe('ok');
    expect(calls[0]!.prompt).toContain('Le prix est passé à 42 CHF.');
    expect(String(calls[0]!.options.systemPrompt)).toContain('veille');
  });

  it('keeps an emergency stop written while an owner’s settings change was in flight', async () => {
    await updateSettings(t.ctx.db, { completionPush: 'long' });
    const state = { at: new Date().toISOString(), reason: 'test', pausedBotIds: [crypto.randomUUID()], cancelledRuns: 0, rejectedApprovals: 0 };
    // The emergency stop holds the row while the owner's PATCH arrives.
    let pending: Promise<unknown> | null = null;
    await t.ctx.sql.begin(async (tx) => {
      await tx`select value from settings where key = 'app' for update`;
      pending = updateSettings(t.ctx.db, { completionPush: 'never' });
      await new Promise((r) => setTimeout(r, 150));
      await tx`update settings set value = value || ${JSON.stringify({ emergencyStop: state })}::jsonb where key = 'app'`;
    });
    await pending;
    const settings = await getSettings(t.ctx.db);
    expect(settings.completionPush).toBe('never');
    expect(settings.emergencyStop).toEqual(state);
  });

  it('resolves who answers a message once, for the dispatch and for the checks made before it', async () => {
    const dev = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    const veille = await createBot(t.ctx, { name: 'Veille', role: 'Veille' });
    expect(await resolveMessageTargets(t.ctx, { channelId: dev.dmChannelId, threadRootId: null, content: '@veille ?' })).toMatchObject({ botIds: [dev.id], trigger: 'user' });
    const group = await createGroupChannel(t.ctx, { name: 'Projet', botIds: [dev.id, veille.id] });
    expect(await resolveMessageTargets(t.ctx, { channelId: group.id, threadRootId: null, content: '@veille regarde' })).toMatchObject({ botIds: [veille.id], trigger: 'mention' });
    expect((await resolveMessageTargets(t.ctx, { channelId: group.id, threadRootId: null, content: 'Bonjour' })).botIds).toEqual([dev.id]);
    const root = await createMessage(t.ctx, { channelId: group.id, authorKind: 'user', content: 'Question' });
    await createMessage(t.ctx, { channelId: group.id, threadRootId: root.id, authorKind: 'bot', botId: veille.id, content: 'Réponse' });
    expect((await resolveMessageTargets(t.ctx, { channelId: group.id, threadRootId: root.id, content: 'Merci' })).botIds).toEqual([veille.id]);
    const empty = await createGroupChannel(t.ctx, { name: 'Vide', botIds: [] });
    expect((await resolveMessageTargets(t.ctx, { channelId: empty.id, threadRootId: null, content: 'Allô' })).botIds).toEqual([]);
  });

  it('records when the afterRun hooks ran, so a closed run is not announced twice', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'Développeur' });
    const run = await dmRun(bot);
    await t.ctx.db.update(runs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(runs.id, run.id));
    const row = (await getRun(t.ctx, run.id))!;
    const deps = workerDeps(t.ctx, answer('x').query);
    await afterRunClosed(deps, row);
    await afterRunClosed(deps, (await getRun(t.ctx, run.id))!);
    expect(finished).toHaveLength(1);
    // An active run is not « finished ».
    const active = await dmRun(bot);
    await patchRunPayload(t.ctx, active.id, {});
    await afterRunClosed(deps, (await getRun(t.ctx, active.id))!);
    expect(finished).toHaveLength(1);
    expect(DEFAULT_SETTINGS.completionPush).toBe('long');
  });
});
