import { lt } from 'drizzle-orm';
import { localDateKey, localMinutes, parseHHMM, type AppSettings } from '@ant/shared';
import { authChallenges, authSessions, budgetAlerts, loginAttempts } from '../db/schema';
import { audit } from '../lib/audit';
import { enqueue, purgeOldJobs } from '../lib/jobs';
import { getSettings } from '../lib/settings';
import { expireApprovals } from '../services/approvals';
import { activeBots } from '../services/bots';
import { createMessage } from '../services/messages';
import { notifyOwner } from '../services/push';
import { clearSubscriptionLimit, getComputeState } from '../services/quota';
import { advanceRoutine, dueRoutines } from '../services/routines';
import { requestRun } from '../services/runs';
import { checkBudgetAlerts } from './alerts';
import type { WorkerDeps } from './deps';
import { heartbeatDue } from './heartbeat';

/** One scheduler pass (every 30 s). Idempotent thanks to job dedupe keys. */
export async function schedulerTick(deps: WorkerDeps, now = new Date()): Promise<void> {
  const settings = await getSettings(deps.ctx.db);
  await scheduleHeartbeats(deps, settings, now);
  await fireRoutines(deps, now);
  await scheduleDigest(deps, settings, now);
  await handleExpiredApprovals(deps, now);
  await restoreSubscription(deps, settings, now);
}

async function scheduleHeartbeats(deps: WorkerDeps, settings: AppSettings, now: Date): Promise<void> {
  for (const bot of await activeBots(deps.ctx)) {
    if (!heartbeatDue(bot, settings, now)) continue;
    const slot = Math.floor(now.getTime() / (bot.heartbeatIntervalMin * 60_000));
    await enqueue(deps.ctx.db, 'heartbeat', { botId: bot.id }, { dedupeKey: `hb:${bot.id}:${slot}`, maxAttempts: 1 });
  }
}

async function fireRoutines(deps: WorkerDeps, now: Date): Promise<void> {
  for (const routine of await dueRoutines(deps.ctx, now)) {
    await advanceRoutine(deps.ctx, routine, now);
    const run = await requestRun(deps.ctx, {
      botId: routine.botId,
      channelId: routine.channelId,
      threadRootId: null,
      trigger: 'routine',
      priority: routine.urgent ? 'normal' : 'background',
      origin: 'autonomous',
      prompt: routine.instruction,
      payload: { routineId: routine.id },
    });
    await audit(deps.ctx.db, { actor: 'system', event: 'routine.fire', runId: run?.id ?? null, detail: { routineId: routine.id, cron: routine.cron }, outcome: run ? 'queued' : 'skipped' });
  }
}

async function scheduleDigest(deps: WorkerDeps, settings: AppSettings, now: Date): Promise<void> {
  if (!settings.digestEnabled) return;
  const target = parseHHMM(settings.digestTime);
  const current = localMinutes(now, settings.timezone);
  if (current < target || current > target + 60) return;
  await enqueue(deps.ctx.db, 'digest', {}, { dedupeKey: `digest:${localDateKey(now, settings.timezone)}`, maxAttempts: 1 });
}

async function handleExpiredApprovals(deps: WorkerDeps, now: Date): Promise<void> {
  for (const a of await expireApprovals(deps.ctx, now)) {
    if (a.channelId) {
      await createMessage(deps.ctx, {
        channelId: a.channelId,
        threadRootId: a.threadRootId,
        authorKind: 'system',
        content: `⌛ La validation « ${a.title} » a expiré sans réponse : l’action n’a pas été faite.`,
        meta: { kind: 'approval', approvalId: a.id },
      });
    }
    await audit(deps.ctx.db, { actor: 'system', event: 'approval.expired', runId: a.runId, detail: { approvalId: a.id }, outcome: 'expired' });
  }
}

async function restoreSubscription(deps: WorkerDeps, settings: AppSettings, now: Date): Promise<void> {
  const state = await getComputeState(deps.ctx);
  const windowsReset =
    (state.subFiveHourResetsAt && state.subFiveHourResetsAt.getTime() <= now.getTime()) ||
    (state.subSevenDayResetsAt && state.subSevenDayResetsAt.getTime() <= now.getTime());
  if (state.subLimitedUntil && state.subLimitedUntil.getTime() <= now.getTime()) {
    await clearSubscriptionLimit(deps.ctx);
    await audit(deps.ctx.db, { actor: 'system', event: 'compute.subscription_restored' });
    await notifyOwner(deps.ctx, deps.push, settings, {
      title: 'Abonnement de nouveau disponible',
      body: 'La limite est réinitialisée : Ant repasse sur ton abonnement.',
      url: '/quota',
      tag: 'sub-restored',
    });
  } else if (windowsReset) {
    await clearSubscriptionLimit(deps.ctx);
  }
}

/** Hourly housekeeping. */
export async function maintenance(deps: WorkerDeps, now = new Date()): Promise<void> {
  const { db } = deps.ctx;
  await purgeOldJobs(db, new Date(now.getTime() - 7 * 86_400_000));
  await db.delete(authChallenges).where(lt(authChallenges.expiresAt, now));
  await db.delete(authSessions).where(lt(authSessions.expiresAt, new Date(now.getTime() - 86_400_000)));
  await db.delete(loginAttempts).where(lt(loginAttempts.at, new Date(now.getTime() - 30 * 86_400_000)));
  const settings = await getSettings(db);
  await checkBudgetAlerts(deps, settings, now);
  await tokenExpiryReminder(deps, settings, now);
}

async function tokenExpiryReminder(deps: WorkerDeps, settings: AppSettings, now: Date): Promise<void> {
  if (!settings.subscriptionTokenCreatedAt) return;
  const expires = new Date(new Date(settings.subscriptionTokenCreatedAt).getTime() + 365 * 86_400_000);
  const daysLeft = Math.floor((expires.getTime() - now.getTime()) / 86_400_000);
  if (daysLeft > 30) return;
  const week = `${now.getUTCFullYear()}-w${Math.floor(now.getTime() / (7 * 86_400_000))}`;
  const inserted = await deps.ctx.db
    .insert(budgetAlerts)
    .values({ scope: 'token_expiry', periodKey: week, threshold: Math.max(daysLeft, 0) })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return;
  await notifyOwner(deps.ctx, deps.push, settings, {
    title: daysLeft > 0 ? `Jeton d’abonnement : expiration dans ${daysLeft} jours` : 'Jeton d’abonnement expiré',
    body: 'Génère un nouveau jeton avec « claude setup-token », mets-le dans CLAUDE_CODE_OAUTH_TOKEN puis redémarre le worker (voir README).',
    url: '/quota',
    tag: 'token-expiry',
    level: 'warning',
    urgent: daysLeft <= 3,
  });
}
