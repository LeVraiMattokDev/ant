import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_BOT_PERMISSIONS, DEFAULT_SETTINGS } from '@ant/shared';
import { jobs, messages, routines, runs } from '../src/db/schema';
import { updateSettings } from '../src/lib/settings';
import { archiveBot, createBot } from '../src/services/bots';
import { createMessage } from '../src/services/messages';
import { patchComputeState } from '../src/services/quota';
import { createRoutine, dueRoutines, routineThreadKey } from '../src/services/routines';
import { patchRunPayload, requestRun } from '../src/services/runs';
import { singleFlight } from '../src/worker/main';
import type { RunContext } from '../src/worker/run-context';
import { SUPERSEDED_OCCURRENCE, schedulerTick } from '../src/worker/scheduler';
import { antTools } from '../src/worker/tools';
import { createTestDb, databaseAvailable, fakeQuery, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();

describe('scheduler pass', () => {
  it('runs one pass at a time: a call while the previous pass is still going starts nothing', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const errors: unknown[] = [];
    const pass = singleFlight(
      () => {
        calls++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      (err) => errors.push(err),
    );
    const first = pass();
    void pass();
    void pass();
    expect(calls).toBe(1);
    release();
    await first;
    // The next pass runs again; a failing pass is reported and does not block the following ones.
    const failing = singleFlight(
      async () => {
        calls++;
        throw new Error('base injoignable');
      },
      (err) => errors.push(err),
    );
    await failing();
    await failing();
    expect(calls).toBe(3);
    expect(errors).toHaveLength(2);
    void pass();
    expect(calls).toBe(4);
    release();
  });
});

describe.skipIf(!hasDb)('scheduler and routines: follow-up fixes', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate runs, run_model_usage, messages, jobs, agent_sessions, approvals, routines, channel_members, channels, bots, compute_state, budget_alerts, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
    await updateSettings(t.ctx.db, { quietHours: null, digestEnabled: false });
  });

  const deps = () => workerDeps(t.ctx, fakeQuery(async function* () {}).query);
  const makeDue = (id: string) => t.ctx.db.update(routines).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(routines.id, id));

  it('keeps at most one scheduled occurrence of a routine waiting', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'v', heartbeatEnabled: false });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 * * * *', instruction: 'Point' }, 'Europe/Zurich');
    await makeDue(routine.id);
    await schedulerTick(deps());
    const [first] = await t.ctx.db.select().from(runs).where(eq(runs.trigger, 'routine'));
    // The first occurrence is paused for lack of compute, with its ⏸️ notice.
    const notice = await createMessage(t.ctx, { channelId: bot.dmChannelId, authorKind: 'system', content: '⏸️ Tâche autonome en attente…' });
    await t.ctx.db.update(runs).set({ status: 'paused' }).where(eq(runs.id, first!.id));
    await patchRunPayload(t.ctx, first!.id, { pauseNotified: true, pauseMessageId: notice.id });
    // The owner's own run of the routine is never replaced.
    const manual = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: bot.dmChannelId,
      threadRootId: null,
      threadKey: routineThreadKey(routine.id),
      trigger: 'routine',
      priority: 'interactive',
      origin: 'user',
      prompt: 'Point',
      payload: { routineId: routine.id },
    });

    await makeDue(routine.id);
    await schedulerTick(deps());
    const all = await t.ctx.db.select().from(runs).where(eq(runs.botId, bot.id));
    expect(all).toHaveLength(3);
    expect(all.find((r) => r.id === first!.id)).toMatchObject({ status: 'cancelled', error: SUPERSEDED_OCCURRENCE });
    expect(all.find((r) => r.id === manual!.id)?.status).toBe('queued');
    expect(all.filter((r) => r.origin === 'autonomous' && r.status === 'queued')).toHaveLength(1);
    const updated = await t.ctx.db.query.messages.findFirst({ where: eq(messages.id, notice.id) });
    expect(updated?.content).toContain('⏹️');
  });

  it('leaves an occurrence alone while a worker is starting it', async () => {
    const bot = await createBot(t.ctx, { name: 'Veille', role: 'v', heartbeatEnabled: false });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 * * * *', instruction: 'Point' }, 'Europe/Zurich');
    await makeDue(routine.id);
    await schedulerTick(deps());
    const [first] = await t.ctx.db.select().from(runs).where(eq(runs.trigger, 'routine'));
    // Claimed by a worker, run not yet marked running.
    await t.ctx.db.update(jobs).set({ status: 'running' }).where(and(eq(jobs.kind, 'bot.run')));
    await makeDue(routine.id);
    await schedulerTick(deps());
    expect((await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, first!.id) }))?.status).toBe('queued');
  });

  it('never fires (nor advances) the routines of an archived bot', async () => {
    const bot = await createBot(t.ctx, { name: 'Ancien', role: 'a', heartbeatEnabled: false });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'x', cron: '0 8 * * *', instruction: 'Point' }, 'Europe/Zurich');
    await archiveBot(t.ctx, bot.id);
    // Even re-enabled behind the service's back (archiving disables them).
    await t.ctx.db.update(routines).set({ enabled: true, nextRunAt: new Date(Date.now() - 1000) }).where(eq(routines.id, routine.id));
    expect(await dueRoutines(t.ctx)).toHaveLength(0);
    await schedulerTick(deps());
    expect(await t.ctx.db.select().from(runs)).toHaveLength(0);
    expect((await t.ctx.db.query.routines.findFirst({ where: eq(routines.id, routine.id) }))?.lastRunAt).toBeNull();
  });

  it('keeps scheduling the other bots’ heartbeats, the routines and the digest when one bot’s data is broken', async () => {
    await updateSettings(t.ctx.db, { digestEnabled: true, digestTime: '00:00' });
    const broken = await createBot(t.ctx, { name: 'Cassé', role: 'x' });
    const healthy = await createBot(t.ctx, { name: 'Sain', role: 'y' });
    // Scheduling this bot's heartbeat fails (here: the database refuses its job).
    await t.ctx.sql.unsafe(`create or replace function reject_heartbeat() returns trigger language plpgsql as $$
      begin
        if new.kind = 'heartbeat' and new.payload->>'botId' = '${broken.id}' then raise exception 'données du bot illisibles'; end if;
        return new;
      end $$`);
    await t.ctx.sql`create trigger reject_heartbeat before insert on jobs for each row execute function reject_heartbeat()`;
    onTestFinished(async () => {
      await t.ctx.sql`drop trigger if exists reject_heartbeat on jobs`;
    });
    const routine = await createRoutine(t.ctx, { botId: healthy.id, sourceText: 'x', cron: '0 * * * *', instruction: 'Point' }, 'Europe/Zurich');
    await makeDue(routine.id);
    // Just after midnight in Zurich: the digest window is open.
    const now = new Date('2026-10-13T22:10:00Z');
    await t.ctx.db.update(routines).set({ nextRunAt: new Date(now.getTime() - 1000) }).where(eq(routines.id, routine.id));
    await schedulerTick(deps(), now);
    const heartbeats = await t.ctx.db.select().from(jobs).where(eq(jobs.kind, 'heartbeat'));
    expect(heartbeats.map((j) => j.payload.botId)).toEqual([healthy.id]);
    expect(await t.ctx.db.select().from(runs).where(eq(runs.trigger, 'routine'))).toHaveLength(1);
    expect(await t.ctx.db.select().from(jobs).where(eq(jobs.kind, 'digest'))).toHaveLength(1);
  });

  it('proposes a routine in the bot’s own conversation when it works in another bot’s', async () => {
    const alpha = await createBot(t.ctx, { name: 'Alpha', role: 'a', heartbeatEnabled: false });
    const bravo = await createBot(t.ctx, { name: 'Bravo', role: 'b', heartbeatEnabled: false });
    // Bravo, handed a task in Alpha's private conversation.
    const run = await requestRun(t.ctx, { botId: bravo.id, channelId: alpha.dmChannelId, threadRootId: null, trigger: 'handoff', priority: 'normal', origin: 'user', prompt: 'x' });
    const rc: RunContext = {
      deps: deps(),
      settings: DEFAULT_SETTINGS,
      run: (await t.ctx.db.query.runs.findFirst({ where: eq(runs.id, run!.id) }))!,
      bot: (await t.ctx.db.query.bots.findFirst({ where: (b, { eq: e }) => e(b.id, bravo.id) }))!,
      permissions: DEFAULT_BOT_PERMISSIONS,
      channel: null,
      computeSource: 'subscription',
      pendingApprovals: [],
      outputs: { attachments: [] },
      botsBySlug: new Map(),
      setActivity: async () => undefined,
    };
    const propose = antTools(rc).find((x) => x.name === 'routine_propose')!;
    const res = await (propose.handler as (a: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean }>)(
      { cron: '0 8 * * 1', instruction: 'Point hebdomadaire', source_text: 'chaque lundi à 8h' },
      {},
    );
    expect(res.isError).toBeFalsy();
    const [routine] = await t.ctx.db.select().from(routines);
    expect(routine).toMatchObject({ botId: bravo.id, channelId: bravo.dmChannelId, proposed: true, enabled: false });
  });
});
