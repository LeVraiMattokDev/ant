import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdir } from 'node:fs/promises';
import type { WorkerStatusDetail } from '@ant/shared';
import type { WorkerConfig } from '../config';
import { createDatabase, runMigrations } from '../db/client';
import { audit } from '../lib/audit';
import { claimJob, completeJob, deferJob, enqueue, failJob, recoverStaleJobs, type ClaimOptions, type JobKind, type JobRow } from '../lib/jobs';
import { logger } from '../lib/logger';
import { getSettings } from '../lib/settings';
import { ComputerClient } from '../services/computer-client';
import { PushSender } from '../services/push';
import { patchComputeState } from '../services/quota';
import { CONTROL_CHANNEL, failRun, sweepOrphanRuns } from '../services/runs';
import { touchServiceStatus } from '../services/service-status';
import { executeApproval } from './approvals-exec';
import { releaseApiBudget } from './compute';
import type { QueryFn, WorkerDeps } from './deps';
import { runDigest } from './digest';
import { runHeartbeat } from './heartbeat';
import { moduleJobHandler, moduleJobKinds, runStartHooks } from './modules';
import { RPC_CHANNEL, parseRoutine } from './routine-parse';
import { rotateSession } from './rotate';
import { SHUTDOWN_REASON, afterRunClosed, executeRun } from './runner';
import { maintenance, schedulerTick } from './scheduler';

const AGENT_KINDS: JobKind[] = ['bot.run'];
/** Core auxiliary kinds, then those the feature modules handle (worker/modules). */
const AUX_KINDS: JobKind[] = [
  ...new Set<JobKind>(['heartbeat', 'routine.parse', 'digest', 'approval.execute', 'session.rotate', 'maintenance', ...moduleJobKinds()]),
];
const AUX_CONCURRENCY = 3;
/** After asking in-flight runs to stop, how long they get to record their usage and requeue themselves. */
const SHUTDOWN_DRAIN_MS = 12_000;

/**
 * What the next agent slot may take. The last free slot is kept for the owner's own requests (interactive runs): a
 * burst of routines, heartbeats or handoffs never makes them wait for a whole background run. With a single slot,
 * everything shares it, or background work would never run.
 */
export function agentClaimOptions(agentActive: number, maxConcurrent: number): ClaimOptions {
  return { onlyInteractive: maxConcurrent > 1 && agentActive >= maxConcurrent - 1 };
}

/**
 * Runs `task` at most once at a time: a call made while the previous run is still going does nothing (the scheduler
 * pass: overlapping passes are safe, atomic claims, but a slow one — database under load — would only pile more
 * work up behind it). An error is reported to `onError`, and the next call runs again.
 */
export function singleFlight(task: () => Promise<void>, onError: (err: unknown) => void): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    if (running) return running;
    running = task()
      .catch(onError)
      .finally(() => {
        running = null;
      });
    return running;
  };
}

/** Maintenance runs as a queued job keyed by the hour: at start-up, then once per clock hour, even across restarts. */
function enqueueMaintenance(db: WorkerDeps['ctx']['db'], now = new Date()): Promise<string | null> {
  return enqueue(db, 'maintenance', {}, { dedupeKey: `maint:${Math.floor(now.getTime() / 3600_000)}`, maxAttempts: 1 });
}

export interface WorkerHandle {
  stop(): Promise<void>;
  deps: WorkerDeps;
}

export async function startWorker(cfg: WorkerConfig, opts: { query?: QueryFn; migrate?: boolean } = {}): Promise<WorkerHandle> {
  if (opts.migrate !== false) await runMigrations(cfg.DATABASE_URL, cfg.MIGRATIONS_DIR);
  await mkdir(cfg.CLAUDE_CONFIG_DIR, { recursive: true });
  await mkdir(cfg.AGENT_CWD, { recursive: true });
  const database = createDatabase(cfg.DATABASE_URL, 10);
  const ctx = { db: database.db, sql: database.sql };
  const deps: WorkerDeps = {
    ctx,
    cfg,
    push: new PushSender(ctx, { publicKey: cfg.VAPID_PUBLIC_KEY, privateKey: cfg.VAPID_PRIVATE_KEY, subject: cfg.VAPID_SUBJECT }),
    computer: new ComputerClient(cfg.COMPUTER_URL, cfg.COMPUTER_RPC_TOKEN),
    log: logger,
    query: opts.query ?? query,
  };

  // Tell the web service which credentials exist (never their values) and reset auth failures:
  // a restart usually follows a credential change.
  await patchComputeState(ctx, {
    subConfigured: Boolean(cfg.CLAUDE_CODE_OAUTH_TOKEN),
    apiConfigured: Boolean(cfg.ANTHROPIC_API_KEY),
    subAuthFailed: false,
    apiAuthFailed: false,
  });
  const recovered = await recoverStaleJobs(ctx.db, new Date());
  if (recovered) logger.info({ recovered }, 'recovered jobs left running by a previous process');
  // No job will ever pick an orphan up: the feature modules learn its final state here.
  const closeOrphans = () => sweepOrphanRuns(ctx, new Date(), undefined, (run) => afterRunClosed(deps, run));
  const orphans = await closeOrphans();
  if (orphans) logger.warn({ orphans }, 'closed runs that no job was executing any more');
  await audit(ctx.db, {
    actor: 'system',
    event: 'worker.start',
    detail: { subscription: Boolean(cfg.CLAUDE_CODE_OAUTH_TOKEN), api: Boolean(cfg.ANTHROPIC_API_KEY), computer: Boolean(cfg.COMPUTER_RPC_TOKEN) },
  });
  // Liveness read by the web service (QuotaStatusDTO.worker, Santé screen): written now, then on every scheduler pass.
  const liveness: WorkerStatusDetail = {
    workerId: cfg.WORKER_ID,
    startedAt: new Date().toISOString(),
    subscriptionConfigured: Boolean(cfg.CLAUDE_CODE_OAUTH_TOKEN),
    apiConfigured: Boolean(cfg.ANTHROPIC_API_KEY),
    computerConfigured: Boolean(cfg.COMPUTER_RPC_TOKEN),
  };
  const beat = () => touchServiceStatus(ctx, 'worker', liveness).catch((err) => logger.warn({ err }, 'worker liveness not recorded'));
  await beat();
  await runStartHooks(deps);

  const controllers = new Map<string, AbortController>();
  const { unlisten } = await ctx.sql.listen(CONTROL_CHANNEL, (payload) => {
    try {
      const msg = JSON.parse(payload) as { type: string; runId?: string };
      if (msg.type === 'cancel' && msg.runId) controllers.get(msg.runId)?.abort();
    } catch {
      // ignore
    }
  });

  let stopping = false;
  let agentActive = 0;
  let auxActive = 0;
  const inFlight = new Set<Promise<void>>();
  let maxConcurrent = (await getSettings(ctx.db)).maxConcurrentRuns;

  async function handle(job: JobRow): Promise<void> {
    const started = Date.now();
    try {
      switch (job.kind) {
        case 'bot.run': {
          const runId = String(job.payload.runId);
          const controller = new AbortController();
          controllers.set(runId, controller);
          try {
            const res = await executeRun(deps, runId, controller.signal);
            if (res.outcome === 'deferred') {
              await deferJob(ctx.db, job.id, res.until, res.reason ?? 'compute paused');
              return;
            }
          } finally {
            controllers.delete(runId);
            releaseApiBudget(runId);
          }
          break;
        }
        case 'heartbeat':
          await runHeartbeat(deps, String(job.payload.botId), Boolean(job.payload.force));
          break;
        case 'digest':
          await runDigest(deps);
          break;
        case 'approval.execute':
          await executeApproval(deps, String(job.payload.approvalId));
          break;
        case 'session.rotate':
          // With the origin of the run that triggered it: after your own messages, hybrid mode may use the subscription.
          await rotateSession(deps, String(job.payload.sessionId), job.payload.origin === 'user' ? 'user' : 'autonomous');
          break;
        case 'routine.parse': {
          const reply = await parseRoutine(deps, String(job.payload.requestId), String(job.payload.text));
          await ctx.sql.notify(RPC_CHANNEL, JSON.stringify(reply));
          break;
        }
        case 'maintenance':
          await maintenance(deps);
          break;
        default: {
          // Feature modules' kinds (worker/modules): the handler's error goes through the usual retry below.
          const handler = moduleJobHandler(job.kind);
          if (handler) await handler(deps, job);
          else logger.warn({ kind: job.kind }, 'unknown job kind');
        }
      }
      await completeJob(ctx.db, job.id);
      logger.debug({ kind: job.kind, ms: Date.now() - started }, 'job done');
    } catch (err) {
      logger.error({ err, kind: job.kind, jobId: job.id }, 'job failed');
      const outcome = await failJob(ctx.db, job, (err as Error).stack ?? String(err));
      if (job.kind === 'routine.parse' && outcome === 'failed') {
        await ctx.sql.notify(RPC_CHANNEL, JSON.stringify({ requestId: job.payload.requestId, ok: false, message: (err as Error).message }));
      }
      if (job.kind === 'bot.run' && outcome === 'failed') {
        // Nothing will execute this run again: close it, or the bot shows « réfléchit » forever.
        await failRun(ctx, String(job.payload.runId), (err as Error).message ?? String(err))
          .then((closed) => (closed ? afterRunClosed(deps, closed) : undefined))
          .catch((e) => logger.error({ err: e, jobId: job.id }, 'could not record the failure of the run'));
      }
    }
  }

  function track(p: Promise<void>): void {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  }

  async function pump(): Promise<void> {
    while (!stopping && agentActive < maxConcurrent) {
      const job = await claimJob(ctx.sql, cfg.WORKER_ID, AGENT_KINDS, agentClaimOptions(agentActive, maxConcurrent));
      if (!job) break;
      agentActive++;
      track(handle(job).finally(() => agentActive--));
    }
    while (!stopping && auxActive < AUX_CONCURRENCY) {
      const job = await claimJob(ctx.sql, cfg.WORKER_ID, AUX_KINDS);
      if (!job) break;
      auxActive++;
      track(handle(job).finally(() => auxActive--));
    }
  }

  const pumpTimer = setInterval(() => {
    pump().catch((err) => logger.error({ err }, 'pump failed'));
  }, 1000);
  const settingsTimer = setInterval(() => {
    getSettings(ctx.db)
      .then((s) => {
        maxConcurrent = s.maxConcurrentRuns;
      })
      .catch(() => undefined);
  }, 10_000);
  // One scheduler pass at a time.
  const pass = singleFlight(
    () => schedulerTick(deps),
    (err) => logger.error({ err }, 'scheduler failed'),
  );
  const tick = () => {
    if (!stopping) void pass();
  };
  const schedulerTimer = setInterval(() => {
    void beat();
    tick();
  }, 30_000);
  const housekeepingTimer = setInterval(() => {
    enqueueMaintenance(ctx.db).catch((err) => logger.error({ err }, 'maintenance scheduling failed'));
    closeOrphans().catch((err) => logger.error({ err }, 'orphan run sweep failed'));
  }, 5 * 60_000);
  tick();
  await enqueueMaintenance(ctx.db);
  logger.info({ workerId: cfg.WORKER_ID }, 'worker started');

  return {
    deps,
    async stop() {
      stopping = true;
      clearInterval(pumpTimer);
      clearInterval(settingsTimer);
      clearInterval(schedulerTimer);
      clearInterval(housekeepingTimer);
      const grace = new Promise((r) => setTimeout(r, 20_000));
      await Promise.race([Promise.allSettled([...inFlight]), grace]);
      // Not a cancellation: each run ends its turn, records its usage and goes back to the queue,
      // to resume its SDK session at the next start (20 s + 12 s fit in the 40 s stop grace period).
      for (const c of controllers.values()) c.abort(SHUTDOWN_REASON);
      await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, SHUTDOWN_DRAIN_MS))]);
      await unlisten().catch(() => undefined);
      await database.close();
    },
  };
}
