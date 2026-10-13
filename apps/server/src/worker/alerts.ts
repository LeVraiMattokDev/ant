import { alertsToSend, localDateKey, localMonthKey, type AppSettings } from '@ant/shared';
import { and, eq } from 'drizzle-orm';
import { budgetAlerts } from '../db/schema';
import { notifyOwner, pushHeldByQuietHours } from '../services/push';
import { apiSpend, effectiveUtilisation, getComputeState, patchComputeState } from '../services/quota';
import type { WorkerDeps } from './deps';

async function sentFor(deps: WorkerDeps, scope: string, periodKey: string): Promise<number[]> {
  const rows = await deps.ctx.db
    .select({ threshold: budgetAlerts.threshold })
    .from(budgetAlerts)
    .where(and(eq(budgetAlerts.scope, scope), eq(budgetAlerts.periodKey, periodKey)));
  return rows.map((r) => r.threshold);
}

/**
 * Records the thresholds as sent and returns those this call inserted. The unique index decides:
 * when two checks run at the same time, each threshold is claimed (and notified) by one of them only.
 */
async function markSent(deps: WorkerDeps, scope: string, periodKey: string, thresholds: number[]): Promise<number[]> {
  if (thresholds.length === 0) return [];
  const rows = await deps.ctx.db
    .insert(budgetAlerts)
    .values(thresholds.map((threshold) => ({ scope, periodKey, threshold })))
    .onConflictDoNothing()
    .returning({ threshold: budgetAlerts.threshold });
  return rows.map((r) => r.threshold);
}

async function checkScope(
  deps: WorkerDeps,
  settings: AppSettings,
  scope: string,
  periodKey: string,
  percent: number | null,
  now: Date,
  describe: (threshold: number) => { title: string; body: string },
): Promise<void> {
  const already = await sentFor(deps, scope, periodKey);
  const fresh = alertsToSend(percent, settings.alertThresholds, already);
  if (fresh.length === 0) return;
  const urgent = Math.max(...fresh) >= 95;
  // Quiet hours would swallow the push: record nothing, so the first check after them sends it
  // (if the period is over by then, its key changed and the stale alert is dropped).
  if (pushHeldByQuietHours(settings, urgent, now)) return;
  const claimed = await markSent(deps, scope, periodKey, fresh);
  if (claimed.length === 0) return;
  const top = Math.max(...claimed);
  const { title, body } = describe(top);
  await notifyOwner(deps.ctx, deps.push, settings, { title, body, url: '/quota', tag: `alert-${scope}`, level: top >= 95 ? 'error' : 'warning', urgent: top >= 95 }, now);
}

export async function checkBudgetAlerts(deps: WorkerDeps, settings: AppSettings, now = new Date()): Promise<void> {
  const spend = await apiSpend(deps.ctx, settings.timezone, null, now);
  const day = localDateKey(now, settings.timezone);
  const month = localMonthKey(now, settings.timezone);
  if (settings.apiDailyCapUsd > 0) {
    const pct = (spend.todayUsd / settings.apiDailyCapUsd) * 100;
    await checkScope(deps, settings, 'api_day', day, pct, now, (t) => ({
      title: `Crédits API : ${t} % du plafond du jour`,
      body: `${spend.todayUsd.toFixed(2)} $ dépensés sur ${settings.apiDailyCapUsd.toFixed(2)} $ aujourd’hui.`,
    }));
  }
  if (settings.apiMonthlyCapUsd > 0) {
    const pct = (spend.monthUsd / settings.apiMonthlyCapUsd) * 100;
    await checkScope(deps, settings, 'api_month', month, pct, now, (t) => ({
      title: `Crédits API : ${t} % du plafond du mois`,
      body: `${spend.monthUsd.toFixed(2)} $ dépensés sur ${settings.apiMonthlyCapUsd.toFixed(2)} $ ce mois-ci.`,
    }));
  }
  const state = await getComputeState(deps.ctx);
  const util = effectiveUtilisation(state, now);
  if (util.fiveHour !== null) {
    const key = state.subFiveHourResetsAt?.toISOString() ?? `${day}-5h`;
    await checkScope(deps, settings, 'sub_5h', key, util.fiveHour, now, (t) => ({
      title: `Abonnement : ${t} % de la fenêtre de 5 h`,
      body: `Utilisation de ton compte Claude (Ant + usage personnel).${state.subFiveHourResetsAt ? ` Réinitialisation à ${state.subFiveHourResetsAt.toLocaleTimeString('fr-CH', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' })}.` : ''}`,
    }));
  }
  if (util.sevenDay !== null) {
    const key = state.subSevenDayResetsAt?.toISOString() ?? `${month}-7d`;
    await checkScope(deps, settings, 'sub_week', key, util.sevenDay, now, (t) => ({
      title: `Abonnement : ${t} % de la limite hebdomadaire`,
      body: 'Utilisation de ton compte Claude (Ant + usage personnel).',
    }));
  }
}

export interface AllPausedOptions {
  /**
   * Let the push through quiet hours (when the owner allowed urgent pushes): only for a request of the
   * owner that is waiting right now. Otherwise a pause found at night is announced when quiet hours end.
   */
  urgent?: boolean;
  now?: Date;
}

const ALL_PAUSED = 'all_paused';

/**
 * No compute for the owner's own requests: record the pause (banner) and tell the owner, once per pause
 * and at most once per local day while it lasts. A pause lasts hours (a daily cap until midnight, a limit
 * until its reset) and its runs retry every 15 minutes: notifying each attempt, or each hour, only repeated
 * the same news day and night. A new pause after compute came back is announced again (see clearAllPaused).
 */
export async function reportAllPaused(deps: WorkerDeps, settings: AppSettings, reason: string, opts: AllPausedOptions = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const urgent = opts.urgent ?? false;
  const state = await getComputeState(deps.ctx);
  if (state.allPausedReason !== reason) await patchComputeState(deps.ctx, { allPausedReason: reason });
  if (pushHeldByQuietHours(settings, urgent, now)) return;
  const claimed = await markSent(deps, ALL_PAUSED, localDateKey(now, settings.timezone), [100]);
  if (claimed.length === 0) return;
  await notifyOwner(
    deps.ctx,
    deps.push,
    settings,
    {
      title: 'Ant est en pause',
      body: `Aucune source de calcul disponible : ${reason}. Les bots reprendront automatiquement.`,
      url: '/quota',
      tag: 'all-paused',
      level: 'error',
      urgent,
    },
    now,
  );
}

/**
 * Compute is back: the pause is over. Its push records go with it, so that the next pause, even later
 * the same day, is a new one and is announced (the records only dedupe the announcement of this one).
 */
export async function clearAllPaused(deps: WorkerDeps): Promise<void> {
  const state = await getComputeState(deps.ctx);
  if (!state.allPausedReason) return;
  await patchComputeState(deps.ctx, { allPausedReason: null });
  await deps.ctx.db.delete(budgetAlerts).where(eq(budgetAlerts.scope, ALL_PAUSED));
}
