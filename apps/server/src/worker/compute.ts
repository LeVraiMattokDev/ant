import {
  decideComputeSource,
  type AppSettings,
  type ComputeDecision,
  type ComputeSource,
  type DecisionInput,
  type RunOrigin,
  type RunPriority,
} from '@ant/shared';
import { apiSpend, effectiveUtilisation, getComputeState } from '../services/quota';
import type { WorkerDeps } from './deps';

export interface DecisionRequest {
  priority: RunPriority;
  origin: RunOrigin;
  botId: string | null;
  botDailyCapUsd: number | null;
}

/** Holds the API budget granted to a call until its real cost is recorded. */
export interface BudgetReservation {
  /** One key per call (a run id, or a one-shot id): a new decision under the same key replaces the old reservation. */
  key: string;
  /** Upper bound of the budget granted (and reserved) for this call. */
  capUsd?: number;
}

/** `heldByInFlight`: paused only because calls still running hold the remaining budget (retry shortly). */
export type WorkerComputeDecision = ComputeDecision & { heldByInFlight?: boolean };

/**
 * API budget granted to calls that are still running. Their cost reaches run_model_usage only
 * when they finish, so without this every concurrent decision would get the whole remaining
 * budget and the daily, monthly and per-bot caps could be exceeded several times over.
 * In memory: a single worker process runs every agent call.
 */
const inFlightApi = new Map<string, { botId: string | null; usd: number }>();

export function releaseApiBudget(key: string): void {
  inFlightApi.delete(key);
}

export function reservedApiBudget(botId: string | null): { total: number; bot: number } {
  let total = 0;
  let bot = 0;
  for (const r of inFlightApi.values()) {
    total += r.usd;
    if (botId && r.botId === botId) bot += r.usd;
  }
  return { total, bot };
}

export async function decideCompute(
  deps: WorkerDeps,
  req: DecisionRequest,
  settings: AppSettings,
  now = new Date(),
  reserve?: BudgetReservation,
): Promise<WorkerComputeDecision> {
  // A re-decision for the same call (after a switch) replaces its reservation instead of stacking one more.
  if (reserve) inFlightApi.delete(reserve.key);
  const state = await getComputeState(deps.ctx);
  const spend = await apiSpend(deps.ctx, settings.timezone, req.botId, now);
  const util = effectiveUtilisation(state, now);
  // No await from here to the reservation: Node runs this block atomically, so two concurrent
  // decisions cannot both see the same remaining budget.
  const input = (held: { total: number; bot: number }): DecisionInput => ({
    mode: settings.computeMode,
    priority: req.priority,
    origin: req.origin,
    now,
    perRunCapUsd: settings.perRunCapUsd,
    thresholds: settings.thresholds,
    subscription: {
      configured: Boolean(deps.cfg.CLAUDE_CODE_OAUTH_TOKEN),
      limitedUntil: state.subLimitedUntil,
      fiveHourUtil: util.fiveHour,
      sevenDayUtil: util.sevenDay,
      authFailed: state.subAuthFailed,
    },
    api: {
      configured: Boolean(deps.cfg.ANTHROPIC_API_KEY),
      authFailed: state.apiAuthFailed,
      spentTodayUsd: spend.todayUsd + held.total,
      spentMonthUsd: spend.monthUsd + held.total,
      dailyCapUsd: settings.apiDailyCapUsd,
      monthlyCapUsd: settings.apiMonthlyCapUsd,
      botSpentTodayUsd: spend.botTodayUsd + held.bot,
      botDailyCapUsd: req.botDailyCapUsd,
    },
  });
  const held = reservedApiBudget(req.botId);
  let decision: WorkerComputeDecision = decideComputeSource(input(held));
  if (decision.source === 'paused' && (held.total > 0 || held.bot > 0) && decideComputeSource(input({ total: 0, bot: 0 })).source !== 'paused') {
    // The budget is only promised to calls in flight: it comes back (or gets spent) within minutes.
    decision = {
      source: 'paused',
      reason: `${decision.reason} — budget réservé par les exécutions en cours`,
      retryAt: new Date(now.getTime() + 2 * 60_000),
      heldByInFlight: true,
    };
  }
  if (decision.source === 'api') {
    const usd = reserve?.capUsd !== undefined ? Math.min(decision.maxBudgetUsd, reserve.capUsd) : decision.maxBudgetUsd;
    decision = { ...decision, maxBudgetUsd: usd };
    if (reserve) inFlightApi.set(reserve.key, { botId: req.botId, usd });
  }
  return decision;
}

/**
 * Environment of the Claude Code subprocess. It REPLACES the inherited environment
 * (Agent SDK `env` option), so database URLs and the other credential never reach it.
 * Only one credential is ever present: ANTHROPIC_API_KEY would take precedence over the OAuth token.
 */
export function buildAgentEnv(cfg: WorkerDeps['cfg'], source: ComputeSource): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    TZ: process.env.TZ ?? 'UTC',
    CLAUDE_CONFIG_DIR: cfg.CLAUDE_CONFIG_DIR,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'ant/0.1.0',
    DISABLE_AUTOUPDATER: '1',
  };
  if (process.env.HTTPS_PROXY) env.HTTPS_PROXY = process.env.HTTPS_PROXY;
  if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
  if (source === 'subscription') {
    if (!cfg.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('CLAUDE_CODE_OAUTH_TOKEN manquant');
    env.CLAUDE_CODE_OAUTH_TOKEN = cfg.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    if (!cfg.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY manquant');
    env.ANTHROPIC_API_KEY = cfg.ANTHROPIC_API_KEY;
  }
  return env;
}
