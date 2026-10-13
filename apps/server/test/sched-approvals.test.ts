import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { approvals, jobs, messages, runs } from '../src/db/schema';
import { claimJob, completeJob, enqueue, failJob, recoverStaleJobs, type JobKind } from '../src/lib/jobs';
import { updateSettings } from '../src/lib/settings';
import { createApproval, decideApproval, getApproval, listApprovals } from '../src/services/approvals';
import { createBot } from '../src/services/bots';
import { createRoutine, routineThreadKey } from '../src/services/routines';
import { patchComputeState } from '../src/services/quota';
import { requestRun, threadKeyFor } from '../src/services/runs';
import { executeApproval } from '../src/worker/approvals-exec';
import type { WorkerDeps } from '../src/worker/deps';
import { schedulerTick } from '../src/worker/scheduler';
import { createTestDb, databaseAvailable, fakeQuery, stubComputer, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();
const AUX: JobKind[] = ['approval.execute'];

describe.skipIf(!hasDb)('approved actions run at most once', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate runs, messages, jobs, agent_sessions, approvals, routines, channel_members, channels, bots, compute_state, budget_alerts, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
    await updateSettings(t.ctx.db, { quietHours: null, digestEnabled: false });
  });

  /** An exec that hangs on its first call (the worker dies during it), then answers. */
  function crashingComputer() {
    let calls = 0;
    const computer = stubComputer({
      exec: () => {
        calls++;
        if (calls === 1) return new Promise(() => undefined);
        return Promise.resolve({ exitCode: 0, stdout: 'poussé\n', stderr: '', timedOut: false, truncated: false, durationMs: 5 });
      },
    });
    return { computer, calls: () => calls };
  }

  async function approvedExec(botId: string, channelId: string, runId: string | null = null) {
    const approval = await createApproval(t.ctx, {
      runId,
      botId,
      channelId,
      threadRootId: null,
      category: 'commande_risquee',
      tool: 'computer_exec',
      title: 'git push',
      summary: 'Pousser la branche main',
      payload: { command: 'git push origin main' },
      expiryHours: 72,
    });
    await decideApproval(t.ctx, approval.id, 'approve', null);
    // Exactly what the web route does after the owner's approval.
    await enqueue(t.ctx.db, 'approval.execute', { approvalId: approval.id }, { dedupeKey: `approval:${approval.id}`, maxAttempts: 1 });
    return approval;
  }

  /** What the worker's pump does with aux jobs. */
  async function drainApprovalJobs(deps: WorkerDeps): Promise<void> {
    for (let job = await claimJob(t.ctx.sql, 'w2', AUX); job; job = await claimJob(t.ctx.sql, 'w2', AUX)) {
      try {
        await executeApproval(deps, String(job.payload.approvalId));
        await completeJob(t.ctx.db, job.id);
      } catch (err) {
        await failJob(t.ctx.db, job, String(err));
      }
    }
  }

  it('does not replay an approved command when the worker restarts during its execution', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const approval = await approvedExec(bot.id, bot.dmChannelId);
    const { computer, calls } = crashingComputer();
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer });

    // Worker 1 claims the job and starts the command, then dies (docker compose up -d, OOM…).
    const job = (await claimJob(t.ctx.sql, 'w1', AUX))!;
    void executeApproval(deps, String(job.payload.approvalId));
    await expect.poll(calls).toBe(1);

    // Worker 2 starts: recovery, then its first scheduler pass and its pump.
    await recoverStaleJobs(t.ctx.db, new Date(Date.now() + 1000));
    await schedulerTick(deps);
    await drainApprovalJobs(deps);
    await schedulerTick(deps);

    expect(calls()).toBe(1);
    const after = await getApproval(t.ctx, approval.id);
    expect(after.status).toBe('failed');
    expect(after.result).toContain('n’a PAS été relancée');
    const notices = await t.ctx.db.select().from(messages).where(and(eq(messages.channelId, bot.dmChannelId), eq(messages.authorKind, 'system')));
    expect(notices.filter((m) => m.content.includes('interrompue par un redémarrage'))).toHaveLength(1);
    // The bot is woken up with the outcome, so it can check the real state.
    const wake = await t.ctx.db.query.runs.findFirst({ where: and(eq(runs.botId, bot.id), eq(runs.trigger, 'approval')) });
    expect(wake?.prompt).toContain('effet est inconnu');
  });

  it('closes the approval instead of running it again when its job is re-queued after it started', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const approval = await approvedExec(bot.id, bot.dmChannelId);
    const { computer, calls } = crashingComputer();
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer });
    const job = (await claimJob(t.ctx.sql, 'w1', AUX))!;
    void executeApproval(deps, approval.id);
    await expect.poll(calls).toBe(1);
    // Whatever puts the job back in the queue, the second execution must not touch the computer.
    await t.ctx.db.update(jobs).set({ status: 'pending', lockedAt: null }).where(eq(jobs.id, job.id));
    await drainApprovalJobs(deps);
    expect(calls()).toBe(1);
    expect((await getApproval(t.ctx, approval.id)).status).toBe('failed');
    expect(await executeApproval(deps, approval.id)).toBe('statut failed : rien à exécuter');
  });

  it('closes an approval whose job was lost before it started, without running it', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const approval = await approvedExec(bot.id, bot.dmChannelId);
    const { computer, calls } = crashingComputer();
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer });
    // Claimed, then the worker died before the execution began: recovery fails the job (one attempt).
    await claimJob(t.ctx.sql, 'w1', AUX);
    await recoverStaleJobs(t.ctx.db, new Date(Date.now() + 1000));

    // Right after the decision it is left alone (the web service enqueues the job just after deciding)…
    await schedulerTick(deps);
    expect((await getApproval(t.ctx, approval.id)).status).toBe('approved');
    // …then closed as « not started ».
    await t.ctx.db.update(approvals).set({ decidedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(approvals.id, approval.id));
    await schedulerTick(deps);
    expect(calls()).toBe(0);
    const after = await getApproval(t.ctx, approval.id);
    expect(after.status).toBe('failed');
    expect(after.result).toContain('Rien n’a été fait');
  });

  it('leaves approvals with a live job alone and still executes them once', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const approval = await approvedExec(bot.id, bot.dmChannelId);
    await t.ctx.db.update(approvals).set({ decidedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(approvals.id, approval.id));
    let calls = 0;
    const computer = stubComputer({
      exec: async () => {
        calls++;
        return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, truncated: false, durationMs: 5 };
      },
    });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer });
    // The job waits for an aux slot: the scheduler must not close the approval meanwhile.
    await schedulerTick(deps);
    expect((await getApproval(t.ctx, approval.id)).status).toBe('approved');
    await drainApprovalJobs(deps);
    expect(calls).toBe(1);
    expect((await getApproval(t.ctx, approval.id)).status).toBe('executed');
    expect(await executeApproval(deps, approval.id)).toBe('statut executed : rien à exécuter');
    await schedulerTick(deps);
    expect((await getApproval(t.ctx, approval.id)).status).toBe('executed');
    expect(calls).toBe(1);
  });

  it('wakes the bot up with the outcome in the session of the run that asked, a routine’s included', async () => {
    const bot = await createBot(t.ctx, { name: 'Dev', role: 'dev' });
    const routine = await createRoutine(t.ctx, { botId: bot.id, sourceText: 'chaque matin', cron: '0 8 * * *', instruction: 'Déploie la préprod' }, 'Europe/Zurich');
    const okComputer = stubComputer({ exec: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, truncated: false, durationMs: 5 }) });
    const deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query, { computer: okComputer });
    const wakeOf = async (approvalId: string) =>
      (await t.ctx.db.select().from(runs).where(and(eq(runs.trigger, 'approval'), eq(runs.botId, bot.id)))).find((r) => r.payload.approvalId === approvalId);

    // Asked by a routine run: its own session (and lane), not the DM conversation it posts in.
    const routineRun = await requestRun(t.ctx, {
      botId: bot.id,
      channelId: routine.channelId,
      threadRootId: null,
      threadKey: routineThreadKey(routine.id),
      trigger: 'routine',
      priority: 'background',
      origin: 'autonomous',
      prompt: routine.instruction,
      payload: { routineId: routine.id },
    });
    const fromRoutine = await approvedExec(bot.id, bot.dmChannelId, routineRun!.id);
    expect(await executeApproval(deps, fromRoutine.id)).toBe('executed');
    const wake = await wakeOf(fromRoutine.id);
    expect(wake?.threadKey).toBe(routineThreadKey(routine.id));
    expect(wake?.channelId).toBe(bot.dmChannelId);
    const lane = await t.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.kind, 'bot.run'), dsql`${jobs.payload}->>'runId' = ${wake!.id}`) });
    expect(lane?.lane).toBe(`run:${bot.id}:${routineThreadKey(routine.id)}`);

    // Asked by a conversation run: the same conversation key as before.
    const convRun = await requestRun(t.ctx, { botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, trigger: 'user', priority: 'interactive', origin: 'user', prompt: 'Pousse la branche' });
    const fromConversation = await approvedExec(bot.id, bot.dmChannelId, convRun!.id);
    await executeApproval(deps, fromConversation.id);
    expect((await wakeOf(fromConversation.id))?.threadKey).toBe(threadKeyFor(bot.dmChannelId, null));

    // The run is gone (purged): the conversation's key, rather than nothing.
    const purged = await approvedExec(bot.id, bot.dmChannelId, '00000000-0000-4000-8000-000000000000');
    await executeApproval(deps, purged.id);
    expect((await wakeOf(purged.id))?.threadKey).toBe(threadKeyFor(bot.dmChannelId, null));
  });

  it('lists approvals with their screenshot flag without loading the captures', async () => {
    const bot = await createBot(t.ctx, { name: 'Web', role: 'web' });
    const base = { runId: null, botId: bot.id, channelId: bot.dmChannelId, threadRootId: null, category: 'navigateur_sensible' as const, tool: 'browser', summary: 'Clic', payload: {}, expiryHours: 72 };
    const withShot = await createApproval(t.ctx, { ...base, screenshotPng: Buffer.from('png').toString('base64') });
    const without = await createApproval(t.ctx, base);
    const list = await listApprovals(t.ctx);
    expect(list.find((a) => a.id === withShot.id)?.hasScreenshot).toBe(true);
    expect(list.find((a) => a.id === without.id)?.hasScreenshot).toBe(false);
  });
});
