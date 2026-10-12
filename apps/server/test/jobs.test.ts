import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '../src/db/schema';
import { claimJob, completeJob, deferJob, enqueue, failJob, recoverStaleJobs } from '../src/lib/jobs';
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
});
