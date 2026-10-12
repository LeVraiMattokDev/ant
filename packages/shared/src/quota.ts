/**
 * Pure decision logic for choosing the compute source of a run:
 * the Claude subscription (CLAUDE_CODE_OAUTH_TOKEN) or API credits (ANTHROPIC_API_KEY).
 * No I/O here so it can be exhaustively unit-tested.
 */

export const COMPUTE_MODES = ['hybrid_safe', 'subscription_then_api', 'subscription_only', 'api_only'] as const;
export type ComputeMode = (typeof COMPUTE_MODES)[number];

export const COMPUTE_MODE_LABELS: Record<ComputeMode, string> = {
  hybrid_safe: 'Hybride prudent (abonnement pour tes demandes, crédits API pour l’autonome)',
  subscription_then_api: 'Abonnement puis crédits API',
  subscription_only: 'Abonnement uniquement',
  api_only: 'Crédits API uniquement',
};

export type ComputeSource = 'subscription' | 'api';

/**
 * interactive: you wrote to a bot / approved an action.
 * normal: bot-to-bot hand-offs and urgent routines.
 * background: heartbeats, regular routines, digests, summaries.
 */
export type RunPriority = 'interactive' | 'normal' | 'background';

/** Who started the work. `user` = triggered by you (directly or through a chain you started). */
export type RunOrigin = 'user' | 'autonomous';

export interface QuotaThresholds {
  /** Above this 5-hour utilisation (%), background work leaves the subscription. */
  reserveFiveHour: number;
  /** Above this weekly utilisation (%), background work leaves the subscription. */
  reserveWeekly: number;
  /** Above this 5-hour utilisation (%), everything leaves the subscription. */
  hardFiveHour: number;
  /** Above this weekly utilisation (%), everything leaves the subscription. */
  hardWeekly: number;
}

export const DEFAULT_THRESHOLDS: QuotaThresholds = {
  reserveFiveHour: 60,
  reserveWeekly: 50,
  hardFiveHour: 90,
  hardWeekly: 85,
};

export interface SubscriptionSnapshot {
  /** A subscription token is configured in the worker environment. */
  configured: boolean;
  /** Set when the subscription refused a request; cleared after reset. */
  limitedUntil: Date | null;
  /** Utilisation percentages (0–100) when known. */
  fiveHourUtil: number | null;
  sevenDayUtil: number | null;
  /** Token rejected (expired / revoked). */
  authFailed: boolean;
}

export interface ApiBudgetSnapshot {
  configured: boolean;
  authFailed: boolean;
  spentTodayUsd: number;
  spentMonthUsd: number;
  dailyCapUsd: number;
  monthlyCapUsd: number;
  botSpentTodayUsd: number;
  botDailyCapUsd: number | null;
}

export interface DecisionInput {
  mode: ComputeMode;
  priority: RunPriority;
  origin: RunOrigin;
  now: Date;
  subscription: SubscriptionSnapshot;
  api: ApiBudgetSnapshot;
  thresholds: QuotaThresholds;
  perRunCapUsd: number;
}

export type ComputeDecision =
  | { source: 'subscription'; reason: string }
  | { source: 'api'; reason: string; maxBudgetUsd: number }
  | { source: 'paused'; reason: string; retryAt: Date | null };

/** Below this remaining amount the API budget is considered exhausted. */
export const MIN_API_RUN_BUDGET_USD = 0.05;

export function apiRemainingUsd(api: ApiBudgetSnapshot): number {
  const caps = [api.dailyCapUsd - api.spentTodayUsd, api.monthlyCapUsd - api.spentMonthUsd];
  if (api.botDailyCapUsd !== null) caps.push(api.botDailyCapUsd - api.botSpentTodayUsd);
  return Math.max(0, Math.min(...caps));
}

function apiStatus(input: DecisionInput): { usable: true; maxBudgetUsd: number } | { usable: false; why: string } {
  const { api } = input;
  if (!api.configured) return { usable: false, why: 'aucune clé API configurée' };
  if (api.authFailed) return { usable: false, why: 'clé API refusée' };
  const remaining = apiRemainingUsd(api);
  if (remaining < MIN_API_RUN_BUDGET_USD) {
    if (api.botDailyCapUsd !== null && api.botDailyCapUsd - api.botSpentTodayUsd < MIN_API_RUN_BUDGET_USD) {
      return { usable: false, why: 'plafond API quotidien de ce bot atteint' };
    }
    if (api.spentMonthUsd >= api.monthlyCapUsd - MIN_API_RUN_BUDGET_USD) {
      return { usable: false, why: 'plafond API mensuel atteint' };
    }
    return { usable: false, why: 'plafond API quotidien atteint' };
  }
  return { usable: true, maxBudgetUsd: round2(Math.min(remaining, input.perRunCapUsd)) };
}

function subscriptionStatus(input: DecisionInput): { usable: true } | { usable: false; why: string; retryAt: Date | null } {
  const { subscription: sub, now, thresholds, priority } = input;
  if (!sub.configured) return { usable: false, why: 'aucun jeton d’abonnement configuré', retryAt: null };
  if (sub.authFailed) return { usable: false, why: 'jeton d’abonnement refusé (expiré ?)', retryAt: null };
  if (sub.limitedUntil && sub.limitedUntil.getTime() > now.getTime()) {
    return { usable: false, why: 'limite de l’abonnement atteinte', retryAt: sub.limitedUntil };
  }
  const background = priority === 'background';
  const fiveLimit = background ? thresholds.reserveFiveHour : thresholds.hardFiveHour;
  const weekLimit = background ? thresholds.reserveWeekly : thresholds.hardWeekly;
  if (sub.fiveHourUtil !== null && sub.fiveHourUtil >= fiveLimit) {
    return {
      usable: false,
      why: `fenêtre 5 h à ${Math.round(sub.fiveHourUtil)} % (seuil ${background ? 'de réserve' : 'maximal'} ${fiveLimit} %)`,
      retryAt: null,
    };
  }
  if (sub.sevenDayUtil !== null && sub.sevenDayUtil >= weekLimit) {
    return {
      usable: false,
      why: `fenêtre hebdomadaire à ${Math.round(sub.sevenDayUtil)} % (seuil ${background ? 'de réserve' : 'maximal'} ${weekLimit} %)`,
      retryAt: null,
    };
  }
  return { usable: true };
}

export function decideComputeSource(input: DecisionInput): ComputeDecision {
  const sub = subscriptionStatus(input);
  const api = apiStatus(input);

  const useApi = (reasonIfApi: string, reasonIfPaused: string): ComputeDecision =>
    api.usable
      ? { source: 'api', reason: reasonIfApi, maxBudgetUsd: api.maxBudgetUsd }
      : { source: 'paused', reason: `${reasonIfPaused} et crédits API indisponibles (${api.why})`, retryAt: sub.usable ? null : sub.retryAt };

  switch (input.mode) {
    case 'api_only':
      return api.usable
        ? { source: 'api', reason: 'mode « crédits API uniquement »', maxBudgetUsd: api.maxBudgetUsd }
        : { source: 'paused', reason: `crédits API indisponibles (${api.why})`, retryAt: null };

    case 'subscription_only':
      return sub.usable
        ? { source: 'subscription', reason: 'mode « abonnement uniquement »' }
        : { source: 'paused', reason: `abonnement indisponible (${sub.why})`, retryAt: sub.retryAt };

    case 'subscription_then_api':
      if (sub.usable) return { source: 'subscription', reason: 'abonnement disponible' };
      return useApi(`bascule sur crédits API : ${sub.why}`, `abonnement indisponible (${sub.why})`);

    case 'hybrid_safe':
      if (input.origin === 'autonomous') {
        return useApi('mode hybride : le travail autonome passe par les crédits API', 'mode hybride : travail autonome réservé aux crédits API');
      }
      if (sub.usable) return { source: 'subscription', reason: 'demande de ta part, abonnement disponible' };
      return useApi(`bascule sur crédits API : ${sub.why}`, `abonnement indisponible (${sub.why})`);
  }
}

/** Returns the alert thresholds (e.g. 50/80/95) newly reached by `percent` and not yet sent. */
export function alertsToSend(percent: number | null, thresholds: readonly number[], alreadySent: readonly number[]): number[] {
  if (percent === null || Number.isNaN(percent)) return [];
  const sent = new Set(alreadySent);
  const reached = thresholds.filter((t) => percent >= t && !sent.has(t));
  // Only the highest newly reached threshold is worth a notification, but all are recorded as sent.
  return reached.sort((a, b) => a - b);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Normalises a utilisation value reported by the Agent SDK into a percentage.
 * The SDK documentation does not specify the unit of `utilization`; the status-line
 * documentation uses 0–100. Values in [0, 1] are treated as fractions.
 */
export function normaliseUtilisation(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (value >= 0 && value <= 1) return round2(value * 100);
  return round2(Math.max(0, Math.min(100, value)));
}
