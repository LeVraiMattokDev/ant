import { and, eq, lt, sql as dsql } from 'drizzle-orm';
import type { Db, Sql } from '../db/client';
import { jobs } from '../db/schema';

/**
 * Every job kind, as the keys of this interface. The feature modules' kinds are declared here up front (their
 * handlers live in worker/modules/<module>.ts); a kind needed later is declared from the module's own file by
 * augmentation, without editing this one:
 *   declare module '../../lib/jobs' { interface JobKinds { 'tracking.something': true } }
 */
export interface JobKinds {
  'bot.run': true;
  heartbeat: true;
  'routine.fire': true;
  digest: true;
  'approval.execute': true;
  'approval.expire': true;
  'subscription.reset': true;
  'session.rotate': true;
  'routine.parse': true;
  maintenance: true;
  /** Notifications & suivi: fires one due followup ({ followupId }). */
  'followup.fire': true;
  /** Santé: connection test of each configured compute source ({}), result in service_status 'diagnostic'. */
  diagnostic: true;
  /** Veilles: checks one watch ({ watchId, manual? }) inside the computer. */
  'watch.check': true;
}

export type JobKind = keyof JobKinds;

export interface EnqueueOptions {
  runAt?: Date;
  lane?: string | null;
  dedupeKey?: string | null;
  maxAttempts?: number;
}

export interface JobRow {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  lane: string | null;
}

/** Inserts a job; returns its id, or null when a job with the same dedupe key already exists. */
export async function enqueue(db: Db, kind: JobKind, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<string | null> {
  const rows = await db
    .insert(jobs)
    .values({
      kind,
      payload,
      runAt: opts.runAt ?? new Date(),
      lane: opts.lane ?? null,
      dedupeKey: opts.dedupeKey ?? null,
      maxAttempts: opts.maxAttempts ?? 3,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

export interface ClaimOptions {
  /**
   * Only claim `bot.run` jobs of interactive runs (the owner's own requests); other kinds are unaffected.
   * Lets the worker keep its last agent slot free for the owner while background work occupies the others.
   */
  onlyInteractive?: boolean;
}

/**
 * Claims at most one due job among `kinds`, never two jobs of the same lane at once.
 * `bot.run` jobs are taken by the priority of their run (interactive, then normal, then background),
 * then in due order; other kinds keep their due order. Claims are serialised with a transaction-scoped advisory lock.
 */
export async function claimJob(sql: Sql, workerId: string, kinds: readonly JobKind[], opts: ClaimOptions = {}): Promise<JobRow | null> {
  if (kinds.length === 0) return null;
  const rows = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(4242)`;
    return tx<
      { id: string; kind: JobKind; payload: Record<string, unknown>; attempts: number; max_attempts: number; lane: string | null }[]
    >`
      update jobs set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
      where id = (
        select j.id from jobs j
        left join runs ru on j.kind = 'bot.run'
          and ru.id = case when j.payload->>'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           then (j.payload->>'runId')::uuid end
        where j.status = 'pending' and j.run_at <= now() and j.kind = any(${tx.array(kinds as string[])})
          and (j.lane is null or not exists (
            select 1 from jobs r where r.lane = j.lane and r.status = 'running'
          ))
          ${opts.onlyInteractive ? tx`and (j.kind <> 'bot.run' or ru.priority = 'interactive')` : tx``}
        order by case ru.priority when 'interactive' then 0 when 'normal' then 1 when 'background' then 2 else 1 end,
                 j.run_at, j.created_at
        limit 1
        for update of j skip locked
      )
      returning id, kind, payload, attempts, max_attempts, lane`;
  });
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts, lane: row.lane };
}

export async function completeJob(db: Db, id: string): Promise<void> {
  await db.update(jobs).set({ status: 'done', finishedAt: new Date(), lockedAt: null }).where(eq(jobs.id, id));
}

/** Marks a job failed, or reschedules it with exponential backoff while attempts remain. */
export async function failJob(db: Db, job: JobRow, error: string, retryable = true): Promise<'retry' | 'failed'> {
  if (retryable && job.attempts < job.maxAttempts) {
    const delayMs = Math.min(30 * 60_000, 15_000 * 2 ** (job.attempts - 1));
    await db
      .update(jobs)
      .set({ status: 'pending', runAt: new Date(Date.now() + delayMs), lastError: error.slice(0, 4000), lockedAt: null, lockedBy: null })
      .where(eq(jobs.id, job.id));
    return 'retry';
  }
  await db
    .update(jobs)
    .set({ status: 'failed', lastError: error.slice(0, 4000), finishedAt: new Date(), lockedAt: null })
    .where(eq(jobs.id, job.id));
  return 'failed';
}

/** Puts a job back in the queue at `runAt` without consuming an attempt (e.g. compute paused). */
export async function deferJob(db: Db, id: string, runAt: Date, reason: string): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: 'pending',
      runAt,
      lastError: reason.slice(0, 4000),
      lockedAt: null,
      lockedBy: null,
      attempts: dsql`greatest(${jobs.attempts} - 1, 0)`,
    })
    .where(eq(jobs.id, id));
}

export const INTERRUPTED_JOB_ERROR = 'interrompu par un redémarrage du worker';

/**
 * At worker start-up: jobs left `running` by a dead process go back to the queue, unless they have used
 * all their attempts. Those fail instead: a job that kills the worker is not retried forever, and a
 * `maxAttempts: 1` job (approved action, digest, heartbeat) is never replayed after it may have had its effect.
 * Returns the number of jobs recovered (re-queued or failed).
 */
export async function recoverStaleJobs(db: Db, olderThan: Date): Promise<number> {
  const exhausted = dsql`${jobs.attempts} >= ${jobs.maxAttempts}`;
  const rows = await db
    .update(jobs)
    .set({
      status: dsql`case when ${exhausted} then 'failed' else 'pending' end`,
      finishedAt: dsql`case when ${exhausted} then now() end`,
      lastError: INTERRUPTED_JOB_ERROR,
      lockedAt: null,
      lockedBy: null,
    })
    .where(and(eq(jobs.status, 'running'), lt(jobs.lockedAt, olderThan)))
    .returning({ id: jobs.id });
  return rows.length;
}

export async function purgeOldJobs(db: Db, olderThan: Date): Promise<void> {
  await db.delete(jobs).where(and(dsql`${jobs.status} in ('done', 'failed')`, lt(jobs.createdAt, olderThan)));
}
