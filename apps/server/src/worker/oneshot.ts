import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings, ComputeSource, EffortLevel, RunOrigin, RunPriority } from '@ant/shared';
import { audit } from '../lib/audit';
import { markSubscriptionLimited, patchComputeState, recordRateLimitEvent, recordUsage, type RateLimitInfo, type UsageRecord } from '../services/quota';
import { checkBudgetAlerts, reportAllPaused } from './alerts';
import { buildAgentEnv, decideCompute } from './compute';
import type { WorkerDeps } from './deps';

export interface OneShotRequest {
  label: string;
  model: string;
  effort: EffortLevel;
  system: string;
  prompt: string;
  /** JSON schema of the expected structured output. */
  schema: Record<string, unknown>;
  priority: RunPriority;
  origin: RunOrigin;
  botId: string | null;
  botDailyCapUsd?: number | null;
}

export type OneShotResult<T> =
  | { ok: true; value: T; source: ComputeSource; costUsd: number }
  | { ok: false; reason: string; paused: boolean };

/**
 * A single structured model call without tools (heartbeat triage, routine parsing,
 * summaries). Goes through the same compute decision and accounting as bot runs.
 */
export async function oneShot<T>(deps: WorkerDeps, settings: AppSettings, req: OneShotRequest): Promise<OneShotResult<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const decision = await decideCompute(
      deps,
      { priority: req.priority, origin: req.origin, botId: req.botId, botDailyCapUsd: req.botDailyCapUsd ?? null },
      settings,
    );
    if (decision.source === 'paused') {
      if (req.priority !== 'background') await reportAllPaused(deps, settings, decision.reason);
      return { ok: false, reason: decision.reason, paused: true };
    }
    const source = decision.source;
    const abort = new AbortController();
    const options: Options = {
      model: req.model,
      effort: req.effort,
      systemPrompt: req.system,
      tools: [],
      allowedTools: [],
      settingSources: [],
      permissionMode: 'default',
      cwd: deps.cfg.AGENT_CWD,
      env: buildAgentEnv(deps.cfg, source),
      outputFormat: { type: 'json_schema', schema: req.schema },
      maxTurns: 4,
      persistSession: false,
      abortController: abort,
      ...(source === 'api' ? { maxBudgetUsd: decision.maxBudgetUsd } : {}),
      ...(deps.cfg.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: deps.cfg.CLAUDE_CODE_EXECUTABLE } : {}),
    };

    let structured: unknown;
    let usage: UsageRecord[] = [];
    let error: string | null = null;
    let limited = false;
    let cost = 0;
    try {
      for await (const msg of deps.query({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
        if (msg.type === 'rate_limit_event') {
          const outcome = await recordRateLimitEvent(deps.ctx, msg.rate_limit_info as unknown as RateLimitInfo);
          if (outcome.limited && source === 'subscription') {
            limited = true;
            abort.abort();
          }
        } else if (msg.type === 'assistant' && msg.error) {
          if (msg.error === 'rate_limit' && source === 'subscription') {
            limited = true;
            await markSubscriptionLimited(deps.ctx, new Date(Date.now() + 30 * 60_000));
            abort.abort();
          } else if (msg.error === 'authentication_failed' || msg.error === 'billing_error') {
            await patchComputeState(deps.ctx, source === 'subscription' ? { subAuthFailed: true } : { apiAuthFailed: true });
            limited = true;
            abort.abort();
          } else {
            error = `Erreur du modèle : ${msg.error}`;
          }
        } else if (msg.type === 'result') {
          usage = Object.entries(msg.modelUsage ?? {}).map(([model, u]) => ({
            runId: null,
            botId: req.botId,
            source,
            model: u.canonicalModel ?? model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadInputTokens,
            cacheWriteTokens: u.cacheCreationInputTokens,
            costUsd: u.costUSD,
          }));
          cost = msg.total_cost_usd ?? 0;
          if (msg.subtype === 'success' && !msg.is_error) structured = msg.structured_output;
          else if (msg.subtype !== 'success') error = msg.errors?.join(' ; ') || msg.subtype;
          else error = msg.result || 'erreur';
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) error = (err as Error).message;
    }
    await recordUsage(deps.ctx, usage, settings.timezone);
    await checkBudgetAlerts(deps, settings);
    await audit(deps.ctx.db, {
      actor: 'system',
      event: 'oneshot',
      detail: { label: req.label, model: req.model, source, costUsd: cost, error },
      outcome: error ? 'error' : limited ? 'switch' : 'ok',
    });
    if (limited) continue;
    if (error) return { ok: false, reason: error, paused: false };
    if (structured === undefined) return { ok: false, reason: 'réponse structurée absente', paused: false };
    return { ok: true, value: structured as T, source, costUsd: cost };
  }
  return { ok: false, reason: 'aucune source de calcul disponible après bascule', paused: true };
}
