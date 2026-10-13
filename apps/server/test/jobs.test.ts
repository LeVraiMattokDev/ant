import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '../src/db/schema';
import type { RunPriority } from '@ant/shared';
import { claimJob, completeJob, deferJob, enqueue, failJob, recoverStaleJobs } from '../src/lib/jobs';
import { createBot } from '../src/services/bots';
import { requestRun } from '../src/services/runs';
import { createTestDb, databaseAvailable, type TestDb } from './helpers';

const hasDb = await databaseAvailable();

describe.skipIf(!hasDb)('job queue', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate jobs`;
  });

  it('never runs two jobs of the same lane at once', async () => {
    await enqueue(t.ctx.db, 'bot.run', { n: 1 }, { lane: 'run:a' });
    await enqueue(t.ctx.db, 'bot.run', { n: 2 }, { lane: 'run:a' });
    await enqueue(t.ctx.db, 'bot.run', { n: 3 }, { lane: 'run:b' });
    const first = await claimJob(t.ctx.sql, 'w', ['bot.run']);
    const second = await claimJob(t.ctx.sql, 'w', ['bot.run']);
    const third = await claimJob(t.ctx.sql, 'w', ['bot.run']);
    expect(first?.payload.n).toBe(1);
    expect(second?.payload.n).toBe(3);
    expect(third).toBeNull();
    await completeJob(t.ctx.db, first!.id);
    expect((await claimJob(t.ctx.sql, 'w', ['bot.run']))?.payload.n).toBe(2);
  });

  it('deduplicates by key', async () => {
    expect(await enqueue(t.ctx.db, 'heartbeat', {}, { dedupeKey: 'hb:1' })).not.toBeNull();
    expect(await enqueue(t.ctx.db, 'heartbeat', {}, { dedupeKey: 'hb:1' })).toBeNull();
  });

  it('respects run_at, kinds, retries with backoff and deferrals', async () => {
    await enqueue(t.ctx.db, 'digest', {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await claimJob(t.ctx.sql, 'w', ['digest'])).toBeNull();
    await enqueue(t.ctx.db, 'maintenance', {}, { maxAttempts: 2 });
    expect(await claimJob(t.ctx.sql, 'w', ['digest'])).toBeNull();
    const job = (await claimJob(t.ctx.sql, 'w', ['maintenance']))!;
    expect(await failJob(t.ctx.db, job, 'boom')).toBe('retry');
    const row = await t.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
    expect(row?.status).toBe('pending');
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now());
    await t.ctx.db.update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.id, job.id));
    const again = (await claimJob(t.ctx.sql, 'w', ['maintenance']))!;
    expect(again.attempts).toBe(2);
    expect(await failJob(t.ctx.db, again, 'boom')).toBe('failed');

    await enqueue(t.ctx.db, 'bot.run', {}, { maxAttempts: 1 });
    const run = (await claimJob(t.ctx.sql, 'w', ['bot.run']))!;
    await deferJob(t.ctx.db, run.id, new Date(Date.now() + 1000), 'paused');
    const deferred = await t.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, run.id) });
    expect(deferred?.status).toBe('pending');
    expect(deferred?.attempts).toBe(0);
  });

  it('recovers jobs left running by a crashed worker', async () => {
    await enqueue(t.ctx.db, 'bot.run', {});
    await claimJob(t.ctx.sql, 'w', ['bot.run']);
    expect(await recoverStaleJobs(t.ctx.db, new Date(Date.now() + 1000))).toBe(1);
    expect(await claimJob(t.ctx.sql, 'w', ['bot.run'])).not.toBeNull();
  });

  it('fails, instead of re-queueing, a job that used all its attempts when the worker died', async () => {
    // A maxAttempts: 1 job (approved action, digest…) must not run again after it may have had its effect,
    // and a job that kills the worker must not crash-loop it forever.
    const id = (await enqueue(t.ctx.db, 'digest', {}, { maxAttempts: 1 }))!;
    await claimJob(t.ctx.sql, 'w', ['digest']);
    expect(await recoverStaleJobs(t.ctx.db, new Date(Date.now() + 1000))).toBe(1);
    const row = await t.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, id) });
    expect(row?.status).toBe('failed');
    expect(row?.finishedAt).toBeTruthy();
    expect(row?.lastError).toContain('redémarrage');
    expect(await claimJob(t.ctx.sql, 'w', ['digest'])).toBeNull();

    // With attempts left it goes back to the queue, and fails once they are used up.
    const runJob = (await enqueue(t.ctx.db, 'bot.run', {}, { maxAttempts: 2 }))!;
    await claimJob(t.ctx.sql, 'w', ['bot.run']);
    await recoverStaleJobs(t.ctx.db, new Date(Date.now() + 1000));
    expect((await t.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, runJob) }))?.status).toBe('pending');
    expect((await claimJob(t.ctx.sql, 'w', ['bot.run']))?.attempts).toBe(2);
    await recoverStaleJobs(t.ctx.db, new Date(Date.now() + 1000));
    expect((await t.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, runJob) }))?.status).toBe('failed');
    expect(await claimJob(t.ctx.sql, 'w', ['bot.run'])).toBeNull();
  });

  describe('run priority', () => {
    let botId: string;
    beforeAll(async () => {
      const bot = await createBot(t.ctx, { name: 'Prio', role: 'tests' });
      botId = bot.id;
    });
    beforeEach(async () => {
      await t.ctx.sql`truncate runs cascade`;
    });

    async function queueRun(priority: RunPriority, key: string, runAt?: Date): Promise<string> {
      const run = await requestRun(t.ctx, {
        botId,
        channelId: null,
        threadRootId: null,
        threadKey: key,
        trigger: priority === 'interactive' ? 'user' : 'routine',
        priority,
        origin: priority === 'interactive' ? 'user' : 'autonomous',
        prompt: key,
        runAt,
      });
      return run!.id;
    }

    it("takes the owner's runs before older background work", async () => {
      const earlier = new Date(Date.now() - 60_000);
      await queueRun('background', 'routine:a', earlier);
      await queueRun('background', 'routine:b', earlier);
      await queueRun('normal', 'handoff', earlier);
      const dm = await queueRun('interactive', 'dm');
      const order: unknown[] = [];
      for (let job = await claimJob(t.ctx.sql, 'w', ['bot.run']); job; job = await claimJob(t.ctx.sql, 'w', ['bot.run'])) order.push(job.payload.runId);
      expect(order[0]).toBe(dm);
      expect(order).toHaveLength(4);
      const prompts = await t.ctx.sql<{ id: string; prompt: string }[]>`select id, prompt from runs`;
      const byId = new Map(prompts.map((r) => [r.id, r.prompt]));
      expect(order.map((id) => byId.get(String(id)))).toEqual(['dm', 'handoff', 'routine:a', 'routine:b']);
    });

    it('can keep a slot for interactive runs only', async () => {
      await queueRun('background', 'routine:a', new Date(Date.now() - 60_000));
      await enqueue(t.ctx.db, 'maintenance', {});
      expect(await claimJob(t.ctx.sql, 'w', ['bot.run'], { onlyInteractive: true })).toBeNull();
      // Other kinds are not filtered.
      expect((await claimJob(t.ctx.sql, 'w', ['maintenance'], { onlyInteractive: true }))?.kind).toBe('maintenance');
      const dm = await queueRun('interactive', 'dm');
      expect((await claimJob(t.ctx.sql, 'w', ['bot.run'], { onlyInteractive: true }))?.payload.runId).toBe(dm);
      expect(await claimJob(t.ctx.sql, 'w', ['bot.run'], { onlyInteractive: true })).toBeNull();
      expect(await claimJob(t.ctx.sql, 'w', ['bot.run'])).not.toBeNull();
    });

    it('still claims bot.run jobs whose payload carries no valid run id', async () => {
      await enqueue(t.ctx.db, 'bot.run', { runId: 'pas-un-uuid' });
      expect((await claimJob(t.ctx.sql, 'w', ['bot.run']))?.payload.runId).toBe('pas-un-uuid');
    });
  });
});
