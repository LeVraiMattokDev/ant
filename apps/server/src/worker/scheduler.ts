import { and, isNotNull, lt, ne } from 'drizzle-orm';
import { localDateKey, localMinutes, parseHHMM, type AppSettings } from '@ant/shared';
import { approvals, authChallenges, authSessions, budgetAlerts, loginAttempts, subscriptionEvents } from '../db/schema';
import { audit } from '../lib/audit';
import { enqueue, purgeOldJobs } from '../lib/jobs';
import { getSettings } from '../lib/settings';
import { expireApprovals } from '../services/approvals';
import { activeBots } from '../services/bots';
import { createMessage } from '../services/messages';
import { notifyOwner, pushHeldByQuietHours } from '../services/push';
import { expireUsageWindows, getComputeState, liftExpiredSubscriptionLimit } from '../services/quota';
import { advanceRoutine, dueRoutines, routineThreadKey } from '../services/routines';
import { requestRun } from '../services/runs';
import { checkBudgetAlerts } from './alerts';
import { closeStrandedApprovals } from './approvals-exec';
import type { WorkerDeps } from './deps';
import { heartbeatDue } from './heartbeat';

const DAY_MS = 86_400_000;

/** One scheduler pass (every 30 s). Safe when passes overlap: job dedupe keys and atomic claims (routines, restore notice, approvals). */
export async function schedulerTick(deps: WorkerDeps, now = new Date()): Promise<void> {
  const settings = await getSettings(deps.ctx.db);
  await scheduleHeartbeats(deps, settings, now);
  await fireRoutines(deps, now);
  await scheduleDigest(deps, settings, now);
  await handleExpiredApprovals(deps, now);
  await closeStrandedApprovals(deps, now);
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
    // Atomic claim: an overlapping pass that read the same occurrence fires nothing.
    if (!(await advanceRoutine(deps.ctx, routine, now))) continue;
    const run = await requestRun(deps.ctx, {
      botId: routine.botId,
      channelId: routine.channelId,
      threadRootId: null,
      // Its own agent session: a routine does not resume (and pay for) the whole conversation it posts in,
      // and remembers its previous occurrences. It still reads what was written there since its last pass.
      threadKey: routineThreadKey(routine.id),
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
  if (state.subLimitedUntil && state.subLimitedUntil.getTime() <= now.getTime()) {
    // Only the pass that actually lifts the limit announces it.
    if (!(await liftExpiredSubscriptionLimit(deps.ctx, now))) return;
    await audit(deps.ctx.db, { actor: 'system', event: 'compute.subscription_restored' });
    await notifyOwner(deps.ctx, deps.push, settings, {
      title: 'Abonnement de nouveau disponible',
      body: 'La limite est réinitialisée : Ant repasse sur ton abonnement.',
      url: '/quota',
      tag: 'sub-restored',
    });
    return;
  }
  const windowsReset =
    (state.subFiveHourResetsAt && state.subFiveHourResetsAt.getTime() <= now.getTime()) ||
    (state.subSevenDayResetsAt && state.subSevenDayResetsAt.getTime() <= now.getTime());
  // A window that reset only clears its own figures: a limit still running (weekly rejection while the
  // 5-hour window resets, or the reverse) stays in force until its own end.
  if (windowsReset) await expireUsageWindows(deps.ctx, now);
}

/** Hourly housekeeping. */
export async function maintenance(deps: WorkerDeps, now = new Date()): Promise<void> {
  const { db } = deps.ctx;
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS);
  await purgeOldJobs(db, daysAgo(7));
  await db.delete(authChallenges).where(lt(authChallenges.expiresAt, now));
  await db.delete(authSessions).where(lt(authSessions.expiresAt, daysAgo(1)));
  await db.delete(loginAttempts).where(lt(loginAttempts.at, daysAgo(30)));
  // Raw rate-limit events are only kept for diagnosis; the current state lives in compute_state.
  await db.delete(subscriptionEvents).where(lt(subscriptionEvents.at, daysAgo(30)));
  // Alert dedupe rows: the longest period is a month, older rows can no longer prevent anything.
  await db.delete(budgetAlerts).where(lt(budgetAlerts.sentAt, daysAgo(90)));
  // Captures of decided approvals (hundreds of KB each, in every backup) are only useful while deciding.
  await db
    .update(approvals)
    .set({ screenshotPng: null })
    .where(and(ne(approvals.status, 'pending'), isNotNull(approvals.screenshotPng), lt(approvals.createdAt, daysAgo(30))));
  const settings = await getSettings(db);
  await checkBudgetAlerts(deps, settings, now);
  await tokenExpiryReminder(deps, settings, now);
}

/** Reminder steps (days left) before the subscription token expires: each one is sent once per token. */
const TOKEN_REMINDER_DAYS = [30, 14, 7, 3, 1] as const;

export async function tokenExpiryReminder(deps: WorkerDeps, settings: AppSettings, now: Date): Promise<void> {
  if (!settings.subscriptionTokenCreatedAt) return;
  const expires = new Date(new Date(settings.subscriptionTokenCreatedAt).getTime() + 365 * DAY_MS);
  const expired = expires.getTime() <= now.getTime();
  const daysLeft = Math.floor((expires.getTime() - now.getTime()) / DAY_MS);
  if (daysLeft > TOKEN_REMINDER_DAYS[0]) return;
  // The smallest step reached (30, 14, 7, 3, then 1 for the last day); 0 once expired.
  const step = expired ? 0 : TOKEN_REMINDER_DAYS.filter((d) => daysLeft <= d).at(-1)!;
  // Once expired, a weekly reminder until a new token is set (a new token has another creation date).
  const periodKey = expired
    ? `tok:${settings.subscriptionTokenCreatedAt}:w${Math.floor(now.getTime() / (7 * DAY_MS))}`
    : `tok:${settings.subscriptionTokenCreatedAt}`;
  const urgent = daysLeft <= 3;
  // Held back by quiet hours: not recorded, so the first maintenance after them sends it.
  if (pushHeldByQuietHours(settings, urgent, now)) return;
  const inserted = await deps.ctx.db
    .insert(budgetAlerts)
    .values({ scope: 'token_expiry', periodKey, threshold: step })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return;
  await notifyOwner(
    deps.ctx,
    deps.push,
    settings,
    {
      title: expired
        ? 'Jeton d’abonnement expiré'
        : `Jeton d’abonnement : expiration dans ${daysLeft >= 1 ? `${daysLeft} jour${daysLeft > 1 ? 's' : ''}` : 'moins d’un jour'}`,
      body: 'Génère un nouveau jeton avec « claude setup-token », mets-le dans CLAUDE_CODE_OAUTH_TOKEN puis redémarre le worker (voir README).',
      url: '/quota',
      tag: 'token-expiry',
      level: 'warning',
      urgent,
    },
    now,
  );
}
