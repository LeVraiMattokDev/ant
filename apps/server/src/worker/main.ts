import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdir } from 'node:fs/promises';
import type { WorkerConfig } from '../config';
import { createDatabase, runMigrations } from '../db/client';
import { audit } from '../lib/audit';
import { claimJob, completeJob, deferJob, failJob, recoverStaleJobs, type JobKind, type JobRow } from '../lib/jobs';
import { logger } from '../lib/logger';
import { getSettings } from '../lib/settings';
import { ComputerClient } from '../services/computer-client';
import { PushSender } from '../services/push';
import { patchComputeState } from '../services/quota';
import { CONTROL_CHANNEL } from '../services/runs';
import { executeApproval } from './approvals-exec';
import type { QueryFn, WorkerDeps } from './deps';
import { runDigest } from './digest';
import { runHeartbeat } from './heartbeat';
import { RPC_CHANNEL, parseRoutine } from './routine-parse';
import { rotateSession } from './rotate';
import { executeRun } from './runner';
import { maintenance, schedulerTick } from './scheduler';

const AGENT_KINDS: JobKind[] = ['bot.run'];
const AUX_KINDS: JobKind[] = ['heartbeat', 'routine.parse', 'digest', 'approval.execute', 'session.rotate', 'maintenance'];
const AUX_CONCURRENCY = 3;

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
  await audit(ctx.db, {
    actor: 'system',
    event: 'worker.start',
    detail: { subscription: Boolean(cfg.CLAUDE_CODE_OAUTH_TOKEN), api: Boolean(cfg.ANTHROPIC_API_KEY), computer: Boolean(cfg.COMPUTER_RPC_TOKEN) },
  });

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
              await deferJob(ctx.db, job.id, res.until, 'compute paused');
              return;
            }
          } finally {
            controllers.delete(runId);
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
          await rotateSession(deps, String(job.payload.sessionId));
          break;
        case 'routine.parse': {
          const reply = await parseRoutine(deps, String(job.payload.requestId), String(job.payload.text));
          await ctx.sql.notify(RPC_CHANNEL, JSON.stringify(reply));
          break;
        }
        case 'maintenance':
          await maintenance(deps);
          break;
        default:
          logger.warn({ kind: job.kind }, 'unknown job kind');
      }
      await completeJob(ctx.db, job.id);
      logger.debug({ kind: job.kind, ms: Date.now() - started }, 'job done');
    } catch (err) {
      logger.error({ err, kind: job.kind, jobId: job.id }, 'job failed');
      const outcome = await failJob(ctx.db, job, (err as Error).stack ?? String(err));
      if (job.kind === 'routine.parse' && outcome === 'failed') {
        await ctx.sql.notify(RPC_CHANNEL, JSON.stringify({ requestId: job.payload.requestId, ok: false, message: (err as Error).message }));
      }
    }
  }

  function track(p: Promise<void>): void {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  }

  async function pump(): Promise<void> {
    while (!stopping && agentActive < maxConcurrent) {
      const job = await claimJob(ctx.sql, cfg.WORKER_ID, AGENT_KINDS);
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
  const schedulerTimer = setInterval(() => {
    schedulerTick(deps).catch((err) => logger.error({ err }, 'scheduler failed'));
  }, 30_000);
  const maintenanceTimer = setInterval(() => {
    maintenance(deps).catch((err) => logger.error({ err }, 'maintenance failed'));
  }, 3600_000);
  schedulerTick(deps).catch((err) => logger.error({ err }, 'scheduler failed'));
  logger.info({ workerId: cfg.WORKER_ID }, 'worker started');

  return {
    deps,
    async stop() {
      stopping = true;
      clearInterval(pumpTimer);
      clearInterval(settingsTimer);
      clearInterval(schedulerTimer);
      clearInterval(maintenanceTimer);
      const grace = new Promise((r) => setTimeout(r, 20_000));
      await Promise.race([Promise.allSettled([...inFlight]), grace]);
      for (const c of controllers.values()) c.abort();
      await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, 5_000))]);
      await unlisten().catch(() => undefined);
      await database.close();
    },
  };
}
