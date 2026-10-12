import { and, eq } from 'drizzle-orm';
import { alertsToSend, localDateKey, localMonthKey, type AppSettings } from '@ant/shared';
import { budgetAlerts } from '../db/schema';
import { notifyOwner } from '../services/push';
import { apiSpend, effectiveUtilisation, getComputeState, patchComputeState } from '../services/quota';
import type { WorkerDeps } from './deps';

async function sentFor(deps: WorkerDeps, scope: string, periodKey: string): Promise<number[]> {
  const rows = await deps.ctx.db
    .select({ threshold: budgetAlerts.threshold })
    .from(budgetAlerts)
    .where(and(eq(budgetAlerts.scope, scope), eq(budgetAlerts.periodKey, periodKey)));
  return rows.map((r) => r.threshold);
}

async function markSent(deps: WorkerDeps, scope: string, periodKey: string, thresholds: number[]): Promise<void> {
  if (thresholds.length === 0) return;
  await deps.ctx.db
    .insert(budgetAlerts)
    .values(thresholds.map((threshold) => ({ scope, periodKey, threshold })))
    .onConflictDoNothing();
}

async function checkScope(
  deps: WorkerDeps,
  settings: AppSettings,
  scope: string,
  periodKey: string,
  percent: number | null,
  describe: (threshold: number) => { title: string; body: string },
): Promise<void> {
  const already = await sentFor(deps, scope, periodKey);
  const fresh = alertsToSend(percent, settings.alertThresholds, already);
  if (fresh.length === 0) return;
  await markSent(deps, scope, periodKey, fresh);
  const top = Math.max(...fresh);
  const { title, body } = describe(top);
  await notifyOwner(deps.ctx, deps.push, settings, { title, body, url: '/quota', tag: `alert-${scope}`, level: top >= 95 ? 'error' : 'warning', urgent: top >= 95 });
}

export async function checkBudgetAlerts(deps: WorkerDeps, settings: AppSettings, now = new Date()): Promise<void> {
  const spend = await apiSpend(deps.ctx, settings.timezone, null, now);
  const day = localDateKey(now, settings.timezone);
  const month = localMonthKey(now, settings.timezone);
  if (settings.apiDailyCapUsd > 0) {
    const pct = (spend.todayUsd / settings.apiDailyCapUsd) * 100;
    await checkScope(deps, settings, 'api_day', day, pct, (t) => ({
      title: `Crédits API : ${t} % du plafond du jour`,
      body: `${spend.todayUsd.toFixed(2)} $ dépensés sur ${settings.apiDailyCapUsd.toFixed(2)} $ aujourd’hui.`,
    }));
  }
  if (settings.apiMonthlyCapUsd > 0) {
    const pct = (spend.monthUsd / settings.apiMonthlyCapUsd) * 100;
    await checkScope(deps, settings, 'api_month', month, pct, (t) => ({
      title: `Crédits API : ${t} % du plafond du mois`,
      body: `${spend.monthUsd.toFixed(2)} $ dépensés sur ${settings.apiMonthlyCapUsd.toFixed(2)} $ ce mois-ci.`,
    }));
  }
  const state = await getComputeState(deps.ctx);
  const util = effectiveUtilisation(state, now);
  if (util.fiveHour !== null) {
    const key = state.subFiveHourResetsAt?.toISOString() ?? `${day}-5h`;
    await checkScope(deps, settings, 'sub_5h', key, util.fiveHour, (t) => ({
      title: `Abonnement : ${t} % de la fenêtre de 5 h`,
      body: `Utilisation de ton compte Claude (Ant + usage personnel).${state.subFiveHourResetsAt ? ` Réinitialisation à ${state.subFiveHourResetsAt.toLocaleTimeString('fr-CH', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' })}.` : ''}`,
    }));
  }
  if (util.sevenDay !== null) {
    const key = state.subSevenDayResetsAt?.toISOString() ?? `${month}-7d`;
    await checkScope(deps, settings, 'sub_week', key, util.sevenDay, (t) => ({
      title: `Abonnement : ${t} % de la limite hebdomadaire`,
      body: 'Utilisation de ton compte Claude (Ant + usage personnel).',
    }));
  }
}

/** Both sources exhausted: record the pause and tell the owner (at most once per hour). */
export async function reportAllPaused(deps: WorkerDeps, settings: AppSettings, reason: string, now = new Date()): Promise<void> {
  const state = await getComputeState(deps.ctx);
  if (state.allPausedReason !== reason) await patchComputeState(deps.ctx, { allPausedReason: reason });
  const hourKey = now.toISOString().slice(0, 13);
  const already = await sentFor(deps, 'all_paused', hourKey);
  if (already.length > 0) return;
  await markSent(deps, 'all_paused', hourKey, [100]);
  await notifyOwner(deps.ctx, deps.push, settings, {
    title: 'Ant est en pause',
    body: `Aucune source de calcul disponible : ${reason}. Les bots reprendront automatiquement.`,
    url: '/quota',
    tag: 'all-paused',
    level: 'error',
    urgent: true,
  });
}

export async function clearAllPaused(deps: WorkerDeps): Promise<void> {
  const state = await getComputeState(deps.ctx);
  if (state.allPausedReason) await patchComputeState(deps.ctx, { allPausedReason: null });
}
