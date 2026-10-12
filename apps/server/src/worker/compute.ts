import {
  decideComputeSource,
  type AppSettings,
  type ComputeDecision,
  type ComputeSource,
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

export async function decideCompute(deps: WorkerDeps, req: DecisionRequest, settings: AppSettings, now = new Date()): Promise<ComputeDecision> {
  const state = await getComputeState(deps.ctx);
  const spend = await apiSpend(deps.ctx, settings.timezone, req.botId, now);
  const util = effectiveUtilisation(state, now);
  return decideComputeSource({
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
      spentTodayUsd: spend.todayUsd,
      spentMonthUsd: spend.monthUsd,
      dailyCapUsd: settings.apiDailyCapUsd,
      monthlyCapUsd: settings.apiMonthlyCapUsd,
      botSpentTodayUsd: spend.botTodayUsd,
      botDailyCapUsd: req.botDailyCapUsd,
    },
  });
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
