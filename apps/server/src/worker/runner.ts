import type {
  AgentDefinition,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  ModelUsage,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { and, desc, eq, gt, isNotNull, isNull, ne, sql as dsql } from 'drizzle-orm';
import {
  DEFAULT_BOT_PERMISSIONS,
  EFFORT_LABELS,
  SUBAGENT_TIERS,
  extractMentions,
  localDateKey,
  localParts,
  modelLabel,
  type AppSettings,
  type BotPermissions,
  type ComputeSource,
  type RunOrigin,
  type SubagentTier,
  type UsagePurpose,
} from '@ant/shared';
import { agentSessions, auditLog, bots, messages, runs } from '../db/schema';
import { audit, botActor } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { getSettings } from '../lib/settings';
import { activeBots, type BotRow } from '../services/bots';
import { channelBotIds, getChannel, type ChannelRow } from '../services/channels';
import { createMessage, getMessage, updateMessage, type MessageRow } from '../services/messages';
import { pinnedMemoryBlock } from '../services/memory';
import { markSubscriptionLimited, patchComputeState, recordRateLimitEvent, recordUsage, sumUsage, type RateLimitInfo, type UsageRecord } from '../services/quota';
import {
  addRunUsage,
  chainStartedAt,
  closeStrandedRun,
  effectiveTrigger,
  getRun,
  patchRunPayload,
  requestRun,
  updateRun,
  type RunRow,
} from '../services/runs';
import { openTasksSummary } from '../services/tasks';
import type { Ctx } from '../services/context';
import { publish } from '../lib/events';
import { enqueue } from '../lib/jobs';
import { checkBudgetAlerts, clearAllPaused, reportAllPaused } from './alerts';
import { buildAgentEnv, decideCompute, releaseApiBudget, type BudgetReservation, type DecisionRequest, type WorkerComputeDecision } from './compute';
import type { WorkerDeps } from './deps';
import { performHandoff } from './handoff';
import {
  moduleBuildPrompt,
  moduleDescribeTrigger,
  moduleSilentRun,
  moduleSystemPromptSections,
  moduleToolActivity,
  moduleUserMessage,
  runAfterRunHooks,
  type FinishedRun,
} from './modules';
import { SUBAGENT_PROMPTS, runContextBlock, sessionSystemPrompt, staticSystemPrompt, systemPromptParts } from './prompt';
import type { RunContext, RunOutputs } from './run-context';
import { LIGHT_SUBAGENT_TOOLS, createAntServer, mcpToolName } from './tools';

export type RunOutcome = { outcome: 'done' | 'cancelled' | 'error' } | { outcome: 'deferred'; until: Date; reason?: string };

/** Abort reason used by the worker when it stops: the run is put back in the queue, not cancelled. */
export const SHUTDOWN_REASON = 'shutdown';

const TERMINAL = new Set(['done', 'cancelled', 'error']);
const CANCELLED = 'Exécution annulée.';
const MAX_ATTEMPTS = 3;
/** After asking the CLI to stop a turn, wait this long for its final result (exact usage) before killing it. */
const STOP_GRACE_MS = 10_000;
/** The only startup error that means the resumed session is really gone. */
const SESSION_NOT_FOUND = /No conversation found with session ID/i;
/** Consecutive runs whose resumed session fails before answering: from this count on, the session is dropped. */
const RESUME_FAILURE_LIMIT = 2;
/** Autonomous work still waiting for compute after this long is dropped instead of replayed late. */
const STALE_AUTONOMOUS_MS = 6 * 3600_000;
/** Automatic follow-up runs after the step limit, per original request. */
const MAX_CONTINUATIONS = 2;
const UNSEEN_LIMIT = 40;
const HISTORY_LIMIT = 30;

const RESUME_NOTES = {
  switch: 'Ta réponse précédente a été interrompue par un changement de source de calcul. Reprends exactement là où tu en étais et termine la tâche.',
  pause: 'Ta réponse précédente a été interrompue faute de source de calcul disponible. Reprends là où tu en étais et termine la tâche.',
  restart:
    'Ant a redémarré pendant ta tâche. Vérifie d’abord ce qui est déjà fait (fichiers, tâches, navigateur, messages publiés), puis termine sans refaire les actions déjà effectuées.',
} as const;

/**
 * Sent with the full request when an interrupted run cannot simply continue its session (another
 * run used it in the meantime, or it was rotated or lost): part of the work may already be done.
 */
const INTERRUPTED_NOTES = {
  pause:
    'Reprise : cette demande avait déjà été commencée, puis interrompue faute de source de calcul. Vérifie d’abord ce qui en est déjà fait, puis termine-la sans refaire les actions déjà effectuées.',
  restart:
    'Reprise : cette demande avait déjà été commencée, puis interrompue par un redémarrage d’Ant. Vérifie d’abord ce qui en est déjà fait (fichiers, tâches, navigateur, messages publiés), puis termine-la sans refaire les actions déjà effectuées.',
} as const;

const CONTINUATION_PROMPT =
  'Suite automatique : ta précédente exécution s’est arrêtée à la limite d’étapes. Continue la tâche là où tu t’es arrêté, sans refaire ce qui est déjà fait, puis donne ta réponse finale.';

const TOOL_ACTIVITY: Record<string, string> = {
  computer_exec: 'utilise le terminal',
  browser: 'utilise le navigateur',
  file_read: 'lit des fichiers',
  file_write: 'écrit des fichiers',
  file_edit: 'modifie des fichiers',
  file_list: 'parcourt les fichiers',
  memory_search: 'consulte sa mémoire',
  memory_write: 'met à jour sa mémoire',
  search_messages: 'cherche dans l’historique',
  handoff: 'transfère une tâche',
  WebSearch: 'cherche sur le web',
  Agent: 'délègue à un sous-agent',
};

function activityFor(toolName: string): string {
  const short = toolName.startsWith('mcp__') ? toolName.split('__').pop()! : toolName;
  return TOOL_ACTIVITY[short] ?? moduleToolActivity(short) ?? `utilise ${short}`;
}

/** Payload keys a follow-up run (after the step limit) keeps from the run it continues. */
const CONTINUATION_KEYS = ['routineId', 'reportTo', 'followupId', 'watchId', 'draftId', 'depth'] as const;

/** What the run's model calls were for (`run_model_usage.purpose`): its trigger, or the trigger of the run it continues. */
export function usagePurposeOf(run: Pick<RunRow, 'trigger' | 'payload'>): UsagePurpose {
  // Every run trigger is also a usage purpose.
  return effectiveTrigger(run) satisfies UsagePurpose;
}

/** The run's conversation, or null when it was archived; any other error (connection lost…) propagates: the job retries. */
async function channelOrNull(ctx: Ctx, channelId: string): Promise<ChannelRow | null> {
  try {
    return await getChannel(ctx, channelId);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/** Silent runs post no reply up front: heartbeats (nudges go through a tool) and those a feature module answers itself. */
async function isSilentRun(deps: WorkerDeps, run: RunRow): Promise<boolean> {
  return run.trigger === 'heartbeat' || (await moduleSilentRun(deps, run));
}

/** Runs the feature modules' afterRun hooks on a final state, then records that they ran. */
async function finishHooks(deps: WorkerDeps, settings: AppSettings, finished: FinishedRun): Promise<void> {
  await runAfterRunHooks(deps, settings, finished);
  await patchRunPayload(deps.ctx, finished.run.id, { afterRunAt: new Date().toISOString() });
}

/**
 * The afterRun hooks of a run closed without reaching the normal end of executeRun: cancelled while queued or paused
 * (owner, emergency stop, newer routine occurrence), bot paused or archived, conversation archived, autonomous work
 * dropped for lack of compute, job failed for good, orphan. No answer, no attachment. Does nothing for a run still
 * active, or whose hooks already ran.
 */
export async function afterRunClosed(
  deps: WorkerDeps,
  run: RunRow,
  known: { settings?: AppSettings; bot?: BotRow; channel?: ChannelRow | null } = {},
): Promise<void> {
  const status = run.status;
  if (run.payload.afterRunAt || (status !== 'done' && status !== 'error' && status !== 'cancelled')) return;
  const bot = known.bot ?? (await deps.ctx.db.query.bots.findFirst({ where: eq(bots.id, run.botId) }));
  if (!bot) return;
  const settings = known.settings ?? (await getSettings(deps.ctx.db));
  const channel = known.channel !== undefined ? known.channel : run.channelId ? await channelOrNull(deps.ctx, run.channelId) : null;
  const startedAt = chainStartedAt(run);
  await finishHooks(deps, settings, {
    run,
    bot,
    channel,
    status,
    trigger: effectiveTrigger(run),
    finalText: '',
    error: run.error,
    silent: await isSilentRun(deps, run),
    responseMessageId: run.responseMessageId,
    attachments: [],
    startedAt,
    durationMs: Math.max(0, (run.finishedAt ?? new Date()).getTime() - startedAt.getTime()),
    continued: false,
  });
}

function describeTrigger(run: RunRow): string {
  const custom = moduleDescribeTrigger(run);
  if (custom) return custom;
  switch (run.trigger) {
    case 'user':
      return 'le propriétaire t’écrit';
    case 'mention':
      return 'le propriétaire te mentionne';
    case 'handoff':
      return 'un autre bot te confie une tâche';
    case 'approval':
      return 'retour d’une validation du propriétaire';
    case 'routine':
      return 'routine planifiée';
    case 'digest':
      return 'résumé quotidien';
    case 'heartbeat':
      return 'heartbeat (revue proactive)';
    case 'followup':
      return 'suivi que tu t’étais programmé (ou que le propriétaire t’a confié)';
    case 'watch':
      return 'une page ou un flux que tu surveilles a changé';
    case 'draft':
      return 'le propriétaire a modifié ou refusé un de tes brouillons';
    default:
      return run.payload.continuation ? 'suite automatique d’une tâche longue (limite d’étapes atteinte)' : 'système';
  }
}

interface SessionRow {
  id: string;
  sdkSessionId: string | null;
  summary: string | null;
  lastSeenAt: Date | null;
}

async function activeSession(deps: WorkerDeps, botId: string, threadKey: string): Promise<SessionRow> {
  const { db } = deps.ctx;
  const existing = await db.query.agentSessions.findFirst({
    where: and(eq(agentSessions.botId, botId), eq(agentSessions.threadKey, threadKey), eq(agentSessions.active, true)),
  });
  if (existing) return existing;
  const [created] = await db.insert(agentSessions).values({ botId, threadKey }).onConflictDoNothing().returning();
  if (created) return created;
  return (await db.query.agentSessions.findFirst({
    where: and(eq(agentSessions.botId, botId), eq(agentSessions.threadKey, threadKey), eq(agentSessions.active, true)),
  }))!;
}

function shortLocal(date: Date, timezone: string): string {
  const p = localParts(date, timezone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(p.day)}.${two(p.month)} ${two(p.hour)}:${two(p.minute)}`;
}

/**
 * - `unseen`: what others wrote (or what this bot wrote outside this session) since the bot last read the conversation.
 * - `history`: the recent conversation, for a session that does not know it (first run, or a lost session).
 */
interface ConversationContext {
  mode: 'unseen' | 'history';
  text: string;
  lostSession: boolean;
}

async function conversationContext(
  deps: WorkerDeps,
  run: RunRow,
  bot: BotRow,
  session: SessionRow,
  names: Map<string, string>,
  timezone: string,
  opts: { history: boolean; lostSession: boolean },
): Promise<ConversationContext | null> {
  if (!run.channelId) return null;
  const scope = run.threadRootId
    ? dsql`(${messages.id} = ${run.threadRootId} or ${messages.threadRootId} = ${run.threadRootId})`
    : and(eq(messages.channelId, run.channelId), isNull(messages.threadRootId));
  const conditions = [scope, ne(messages.status, 'streaming')];
  if (!opts.history && session.lastSeenAt) {
    // updatedAt, not createdAt: a reply that was still streaming when the context was read becomes visible when it is finalised.
    conditions.push(gt(messages.updatedAt, session.lastSeenAt));
    // This bot's own messages are already in its session, except those written outside it:
    // nudges from a heartbeat, the daily digest, posts made from another conversation.
    conditions.push(
      dsql`(${messages.botId} is null or ${messages.botId} <> ${run.botId} or ${messages.authorKind} = 'system'
        or not exists (select 1 from ${runs} r where r.id::text = coalesce(${messages.runId}::text, ${messages.meta}->>'runId') and r.thread_key = ${run.threadKey}))`,
    );
  }
  const limit = opts.history ? HISTORY_LIMIT : UNSEEN_LIMIT;
  // Newest first, then back in chronological order: when there are too many, the oldest ones are dropped.
  const rows = await deps.ctx.db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit + 2);
  // The triggering message is sent on its own below the context.
  const own = rows.findIndex((r) => r.authorKind === 'user' && r.content === run.prompt);
  if (own >= 0) rows.splice(own, 1);
  const truncated = rows.length > limit;
  const lines = rows
    .slice(0, limit)
    .reverse().map((r) => `[${shortLocal(r.createdAt, timezone)}] ${authorLabel(r, run, bot, names)} : ${r.content}`);
  if (truncated && lines.length) lines.unshift('(messages plus anciens omis — utilise search_messages si besoin)');
  return { mode: opts.history ? 'history' : 'unseen', text: lines.join('\n'), lostSession: opts.lostSession };
}

function authorLabel(r: MessageRow, run: RunRow, bot: BotRow, names: Map<string, string>): string {
  if (r.authorKind === 'user') return 'Propriétaire';
  if (r.authorKind === 'system') return 'Système';
  if (r.botId !== run.botId) return `@${names.get(r.botId ?? '') ?? 'bot'}`;
  if (r.meta.kind === 'nudge') return `Toi (@${bot.slug}, relance proactive)`;
  if (r.meta.kind === 'digest') return `Toi (@${bot.slug}, résumé du jour)`;
  return `Toi (@${bot.slug})`;
}

function buildPrompt(run: RunRow, conversation: ConversationContext | null, interruptedNote: string | null): string {
  let head = '';
  if (conversation?.text) {
    const title =
      conversation.mode === 'unseen'
        ? 'Nouveaux messages dans la conversation depuis ta dernière intervention :'
        : conversation.lostSession
          ? 'Historique récent de la conversation (ta session précédente n’a pas pu être reprise) :'
          : 'Historique récent de la conversation :';
    head = `${title}\n${conversation.text}\n\n---\n`;
  }
  if (interruptedNote) head = `${head}${interruptedNote}\n\n`;
  const custom = moduleBuildPrompt(run, head);
  if (custom !== null) return custom;
  switch (run.trigger) {
    case 'user':
    case 'mention':
      return `${head}Message du propriétaire :\n${run.prompt}`;
    case 'routine':
      return `${head}Routine planifiée — consigne :\n${run.prompt}\n\nExécute-la maintenant et publie le résultat.`;
    default:
      return `${head}${run.prompt}`;
  }
}

interface AttemptResult {
  kind: 'completed' | 'switch' | 'failed' | 'cancelled' | 'resume_failed';
  text: string;
  error: string | null;
  /** Raw per-model totals of the SDK result (cumulative since the SDK session began), null without a result. */
  totals: Record<string, ModelUsage> | null;
  sessionId: string | null;
  contextTokens: number;
  switchReason?: string;
  /** The turn ended on the step limit (maxTurns). */
  maxTurns?: boolean;
  /** The model produced at least one real (non-error) assistant message. */
  answered: boolean;
  /** Error code of an assistant message that reported an API error, if any. */
  apiError: string | null;
}

/** Compact per-model totals, keyed by the raw modelUsage key. */
type UsageTotals = Record<string, { i: number; o: number; cr: number; cw: number; c: number }>;

function compactTotals(modelUsage: Record<string, ModelUsage>): UsageTotals {
  return Object.fromEntries(
    Object.entries(modelUsage).map(([key, u]) => [
      key,
      { i: u.inputTokens ?? 0, o: u.outputTokens ?? 0, cr: u.cacheReadInputTokens ?? 0, cw: u.cacheCreationInputTokens ?? 0, c: u.costUSD ?? 0 },
    ]),
  );
}

function hasUsage(totals: UsageTotals): boolean {
  return Object.values(totals).some((t) => t.i + t.o + t.cr + t.cw > 0 || t.c > 0);
}

/**
 * This attempt's own usage. A resumed session's result carries the totals of every earlier turn
 * of that SDK session (the CLI restores them from the transcript), so the totals already recorded
 * for it are subtracted per model. A value below the baseline means the CLI started again from
 * zero (nothing to restore, /clear): the totals are then all new.
 */
function usageDelta(
  current: Record<string, ModelUsage> | null,
  baseline: UsageTotals | null,
  run: Pick<RunRow, 'id' | 'botId' | 'trigger' | 'payload'>,
  source: ComputeSource,
): UsageRecord[] {
  if (!current) return [];
  const now = compactTotals(current);
  return Object.entries(current).map(([key, u]) => {
    const cur = now[key]!;
    const b = baseline?.[key];
    const reset = !b || cur.i < b.i || cur.o < b.o || cur.cr < b.cr || cur.cw < b.cw || cur.c + 1e-9 < b.c;
    const d = reset ? cur : { i: cur.i - b.i, o: cur.o - b.o, cr: cur.cr - b.cr, cw: cur.cw - b.cw, c: cur.c - b.c };
    return {
      runId: run.id,
      botId: run.botId,
      purpose: usagePurposeOf(run),
      routineId: typeof run.payload.routineId === 'string' ? run.payload.routineId : null,
      source,
      model: u.canonicalModel ?? key,
      inputTokens: d.i,
      outputTokens: d.o,
      cacheReadTokens: d.cr,
      cacheWriteTokens: d.cw,
      costUsd: Math.round(Math.max(0, d.c) * 1e8) / 1e8,
    };
  });
}

/** Totals last recorded for an SDK session (stored on the run that reported them). */
async function loadUsageBaseline(ctx: Ctx, botId: string, sdkSessionId: string): Promise<UsageTotals | null> {
  const [row] = await ctx.db
    .select({ totals: dsql<{ models?: UsageTotals } | null>`${runs.payload}->'usageTotals'` })
    .from(runs)
    .where(and(eq(runs.botId, botId), dsql`${runs.payload}->'usageTotals'->>'sdkSessionId' = ${sdkSessionId}`))
    .orderBy(dsql`${runs.payload}->'usageTotals'->>'at' desc`)
    .limit(1);
  return row?.totals?.models ?? null;
}

/**
 * True when no other run has used this SDK session since this run last did: only then does the
 * session still end on this run's own interrupted turn, so that a short « reprends » note is enough.
 * Runs of a conversation share one lane, so any later use of the session came after the interruption.
 */
async function sessionStillOurs(ctx: Ctx, run: RunRow, sdkSessionId: string): Promise<boolean> {
  const since = typeof run.payload.sessionUsedAt === 'string' ? run.payload.sessionUsedAt : run.startedAt?.toISOString();
  if (!since) return false;
  const rows = await ctx.db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.botId, run.botId),
        eq(runs.sdkSessionId, sdkSessionId),
        ne(runs.id, run.id),
        dsql`coalesce((${runs.payload}->>'sessionUsedAt')::timestamptz, ${runs.startedAt}) > ${since}::timestamptz`,
      ),
    )
    .limit(1);
  return rows.length === 0;
}

/** Consecutive earlier runs of this conversation whose resume of this SDK session failed before answering. */
async function previousResumeFailures(ctx: Ctx, run: RunRow, sdkSessionId: string): Promise<number> {
  const [prev] = await ctx.db
    .select({ payload: runs.payload })
    .from(runs)
    .where(
      and(
        eq(runs.botId, run.botId),
        eq(runs.threadKey, run.threadKey),
        ne(runs.id, run.id),
        isNotNull(runs.finishedAt),
        dsql`(${runs.sdkSessionId} = ${sdkSessionId} or ${runs.payload}->'resumeFailure'->>'sdkSessionId' = ${sdkSessionId})`,
      ),
    )
    .orderBy(desc(runs.finishedAt))
    .limit(1);
  // The last run that used this session either failed the same way (its count goes on) or worked (the count restarts).
  const failure = prev?.payload.resumeFailure as { sdkSessionId?: unknown; count?: unknown } | undefined;
  return failure?.sdkSessionId === sdkSessionId ? Number(failure.count) || 0 : 0;
}

/**
 * A resumed attempt that failed without producing any answer: the transcript may be unusable (truncated,
 * incompatible, rejected by the API). Transient API errors (overload, rate limit…) do not count.
 */
function failedAtResume(result: AttemptResult): boolean {
  return result.kind === 'failed' && !result.maxTurns && !result.answered && (result.apiError === null || result.apiError === 'invalid_request');
}

/** Expert sub-agent calls already made today (all bots). */
async function expertCallsToday(deps: WorkerDeps, settings: AppSettings): Promise<number> {
  const day = localDateKey(new Date(), settings.timezone);
  const rows = await deps.ctx.db
    .select({ n: dsql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(eq(auditLog.event, 'subagent.start'), dsql`${auditLog.detail}->>'tier' = 'expert'`, dsql`${auditLog.detail}->>'day' = ${day}`));
  return rows[0]?.n ?? 0;
}

function deny(reason: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

export function extractReason(description: string): string | null {
  const m = /raison\s*:\s*(.+)$/i.exec(description);
  const reason = m?.[1]?.trim();
  return reason && reason.length >= 3 ? reason : null;
}

function buildHooks(rc: RunContext, allowedTools: Set<string>): Partial<Record<'PreToolUse' | 'PostToolUse' | 'SubagentStop', HookCallbackMatcher[]>> {
  const { deps, bot, run } = rc;
  const actor = botActor(bot.slug);

  const preToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const name = input.tool_name;
    if (name === 'Agent' || name === 'Task') {
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const type = String(toolInput.subagent_type ?? '');
      if (type !== 'leger' && type !== 'expert') return deny('Utilise uniquement les sous-agents « leger » ou « expert ».');
      const tier = type as SubagentTier;
      if (tier === 'leger' && !rc.permissions.lightSubagent) return deny('Tu n’as pas le droit d’utiliser le sous-agent léger.');
      if (tier === 'expert' && !rc.permissions.expertSubagent) return deny('Tu n’as pas le droit d’utiliser le sous-agent expert.');
      const description = String(toolInput.description ?? '');
      const reason = extractReason(description);
      if (!reason) return deny('La description doit avoir la forme « <tâche> — raison : <pourquoi ce modèle> ». Recommence avec la raison.');
      if (tier === 'expert') {
        const used = await expertCallsToday(deps, rc.settings);
        if (used >= rc.settings.expertDailyLimit) {
          return deny(`Limite quotidienne d’appels au sous-agent expert atteinte (${rc.settings.expertDailyLimit}). Traite le problème toi-même ou demande au propriétaire.`);
        }
      }
      const def = SUBAGENT_TIERS[tier];
      if (run.channelId) {
        await createMessage(deps.ctx, {
          channelId: run.channelId,
          threadRootId: run.threadRootId,
          authorKind: 'system',
          botId: bot.id,
          content: `↪ @${bot.slug} lance un sous-agent **${def.label}** (effort ${EFFORT_LABELS[def.effort]}) — ${description}`,
          meta: { kind: 'delegation', runId: run.id, subagent: { tier, model: def.model, effort: def.effort, reason } },
        });
      }
      await audit(deps.ctx.db, {
        actor,
        event: 'subagent.start',
        runId: run.id,
        tool: name,
        detail: { tier, model: def.model, effort: def.effort, reason, description, day: localDateKey(new Date(), rc.settings.timezone) },
      });
      await rc.setActivity(`délègue à ${def.label}`);
      // The tier definition decides the model and effort; the call runs in the foreground of this turn.
      const updatedInput = { description, prompt: toolInput.prompt, subagent_type: type, run_in_background: false };
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } };
    }
    if (!allowedTools.has(name)) return deny(`L’outil ${name} n’est pas autorisé pour ce bot.`);
    await rc.setActivity(activityFor(name));
    return {};
  };

  const postToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    // Ant's own tools audit themselves with richer detail; built-ins are audited here.
    if (!input.tool_name.startsWith('mcp__ant__')) {
      await audit(deps.ctx.db, {
        actor: input.agent_type ? `${actor}/${input.agent_type}` : actor,
        event: 'tool',
        runId: run.id,
        tool: input.tool_name,
        detail: { input: input.tool_input },
        outcome: 'ok',
      });
    }
    return {};
  };

  const subagentStop = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'SubagentStop') return {};
    await audit(deps.ctx.db, { actor, event: 'subagent.stop', runId: run.id, detail: { agentType: input.agent_type } });
    return {};
  };

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    SubagentStop: [{ hooks: [subagentStop] }],
  };
}

function subagentDefinitions(p: BotPermissions, parentTools: string[]): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  if (p.lightSubagent) {
    agents.leger = {
      description: `Sous-agent rapide (${SUBAGENT_TIERS.leger.label}) pour les tâches mécaniques : tri, résumé, extraction, reformatage.`,
      prompt: SUBAGENT_PROMPTS.leger,
      model: SUBAGENT_TIERS.leger.model,
      effort: SUBAGENT_TIERS.leger.effort,
      tools: parentTools.filter((t) => LIGHT_SUBAGENT_TOOLS.some((l) => t === mcpToolName(l)) || t === 'WebSearch'),
      maxTurns: 25,
      background: false,
      omitClaudeMd: true,
    };
  }
  if (p.expertSubagent) {
    agents.expert = {
      description: `Sous-agent expert (${SUBAGENT_TIERS.expert.label}) pour les problèmes difficiles : architecture, débogage complexe, décisions importantes.`,
      prompt: SUBAGENT_PROMPTS.expert,
      model: SUBAGENT_TIERS.expert.model,
      effort: SUBAGENT_TIERS.expert.effort,
      tools: parentTools.filter((t) => t !== 'Agent' && t !== mcpToolName('handoff')),
      maxTurns: 60,
      background: false,
      omitClaudeMd: true,
    };
  }
  return agents;
}

/** Continue the session that already holds this run's request, with a short note instead of the request. */
interface ResumeHint {
  sessionId: string;
  note: string;
}

export interface PreparedRun {
  rc: RunContext;
  options: Options;
  /** Text of the request (also what is sent, unless a feature module turned it into `input`). */
  prompt: string;
  /** What is sent to the SDK: the text, or SDK user messages built by a feature module (images, PDF). */
  input: string | AsyncIterable<SDKUserMessage>;
  session: SessionRow;
  /** Read watermark of the conversation shown in the prompt (null when only a resume note was sent). */
  contextAt: Date | null;
}

interface PrepareInput {
  source: ComputeSource;
  maxBudgetUsd: number | null;
  abort: AbortController;
  resume: ResumeHint | null;
  /** The previous SDK session could not be resumed: rebuild the context from the conversation. */
  lostSession: boolean;
  /** Added to the full request when an interrupted run is not continued with a short note. */
  interruptedNote: string | null;
  /** Shared by every attempt of the run. */
  outputs: RunOutputs;
}

async function prepare(deps: WorkerDeps, run: RunRow, bot: BotRow, channel: ChannelRow | null, settings: AppSettings, input: PrepareInput): Promise<PreparedRun> {
  const { source, maxBudgetUsd, abort } = input;
  const permissions: BotPermissions = { ...DEFAULT_BOT_PERMISSIONS, ...bot.permissions };
  const all = await activeBots(deps.ctx);
  const botsBySlug = new Map(all.map((b) => [b.slug, { id: b.id, name: b.name, role: b.role }]));
  const names = new Map(all.map((b) => [b.id, b.slug]));

  const rc: RunContext = {
    deps,
    settings,
    run,
    bot,
    permissions,
    channel,
    computeSource: source,
    pendingApprovals: [],
    botsBySlug,
    setActivity: async (activity) => {
      await updateRun(deps.ctx, run.id, { activity });
      await publish(deps.ctx.sql, { type: 'bot.updated', botId: bot.id });
    },
    outputs: input.outputs,
  };

  const { server, toolNames } = createAntServer(rc);
  const builtins: string[] = [];
  if (permissions.webSearch) builtins.push('WebSearch');
  if (permissions.lightSubagent || permissions.expertSubagent) builtins.push('Agent');
  const allowed = [...builtins, ...toolNames.map(mcpToolName)];
  const allowedSet = new Set(allowed);

  const session = await activeSession(deps, bot.id, run.threadKey);
  let channelDescription = 'aucune (exécution en arrière-plan)';
  if (channel) {
    const memberIds = channel.kind === 'group' ? await channelBotIds(deps.ctx, channel.id) : [];
    const members = memberIds.map((id) => `@${names.get(id) ?? '?'}`).join(', ');
    channelDescription =
      channel.kind === 'dm'
        ? `messages privés entre toi et le propriétaire${run.threadRootId ? ' (dans un fil)' : ''}`
        : `canal de groupe #${channel.name}${channel.topic ? ` (« ${channel.topic} »)` : ''} — bots membres : ${members}${run.threadRootId ? ' — dans un fil' : ''}`;
  }

  // The system prompt only changes when the owner edits the bot (or at a rotation): the resumed history stays cached.
  const staticPart = staticSystemPrompt({
    bot,
    permissions,
    otherBots: all.filter((b) => b.id !== bot.id).map((b) => ({ slug: b.slug, name: b.name, role: b.role })),
    pinnedMemory: await pinnedMemoryBlock(deps.ctx, bot.id),
    extraSections: moduleSystemPromptSections(bot, permissions),
  });
  const sessionPart = sessionSystemPrompt(session.summary);

  // Heartbeats start a fresh session (their prompt carries the context); they only resume the
  // session they started themselves, when an attempt of the same run was interrupted.
  const isHeartbeat = run.trigger === 'heartbeat';
  const resumeId = isHeartbeat ? (input.resume?.sessionId ?? null) : session.sdkSessionId;
  const continuing = input.resume !== null && resumeId !== null && input.resume.sessionId === resumeId;

  let body: string;
  let contextAt: Date | null = null;
  if (continuing) {
    body = input.resume!.note;
  } else {
    // Watermark taken before reading: anything finalised after this moment is shown at the next run.
    contextAt = new Date();
    const history = input.lostSession || !session.lastSeenAt || (!resumeId && !session.summary);
    const conversation = isHeartbeat
      ? null
      : await conversationContext(deps, run, bot, session, names, settings.timezone, { history, lostSession: input.lostSession });
    body = buildPrompt(run, conversation, input.interruptedNote);
  }
  const runContext = runContextBlock({
    now: new Date(),
    timezone: settings.timezone,
    channelDescription,
    triggerDescription: describeTrigger(run),
    openTasks: await openTasksSummary(deps.ctx, bot.id),
  });
  const prompt = `${runContext}\n\n---\n\n${body}`;
  const sdkInput = (await moduleUserMessage(rc, prompt)) ?? prompt;
  // On the subscription, an optional cap in API-equivalent dollars keeps a runaway run from draining the 5-hour window.
  const budget = source === 'api' ? maxBudgetUsd : settings.perRunSubscriptionCapUsd > 0 ? settings.perRunSubscriptionCapUsd : null;

  const options: Options = {
    model: run.model,
    effort: run.effort,
    systemPrompt: systemPromptParts(staticPart, sessionPart),
    tools: builtins,
    allowedTools: allowed,
    mcpServers: { ant: server },
    agents: subagentDefinitions(permissions, allowed),
    hooks: buildHooks(rc, allowedSet),
    canUseTool: async (toolName) =>
      allowedSet.has(toolName)
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: `L’outil ${toolName} n’est pas autorisé pour ce bot.` },
    permissionMode: 'default',
    settingSources: [],
    cwd: deps.cfg.AGENT_CWD,
    env: buildAgentEnv(deps.cfg, source),
    includePartialMessages: true,
    abortController: abort,
    maxTurns: isHeartbeat ? 15 : 80,
    ...(resumeId ? { resume: resumeId } : {}),
    ...(budget !== null ? { maxBudgetUsd: budget } : {}),
    ...(deps.cfg.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: deps.cfg.CLAUDE_CODE_EXECUTABLE } : {}),
  };
  return { rc, options, prompt, input: sdkInput, session, contextAt };
}

interface StreamTarget {
  messageId: string | null;
  channelId: string | null;
}

interface ConsumeInput {
  target: StreamTarget;
  abort: AbortController;
  /** Owner cancellation or worker shutdown. */
  cancel: AbortSignal;
  /** Text already shown in the message by earlier attempts of this run (with its separator). */
  prefix: string;
  /** Called once, as soon as the SDK session id is known (before the turn ends). */
  onSession: (sessionId: string) => Promise<void>;
}

/** Consumes the SDK message stream of one attempt. */
async function consume(deps: WorkerDeps, prepared: PreparedRun, source: ComputeSource, input: ConsumeInput): Promise<AttemptResult> {
  const { rc } = prepared;
  const { target, abort, cancel, prefix } = input;
  const textBlocks: string[] = [];
  let resultText = '';
  let error: string | null = null;
  let totals: Record<string, ModelUsage> | null = null;
  let sessionId: string | null = null;
  let contextTokens = 0;
  let switchReason: string | undefined;
  let maxTurns = false;
  let sawAssistant = false;
  let answered = false;
  let apiError: string | null = null;
  let gotResult = false;
  let pending = '';
  let lastFlush = Date.now();
  let liveText = prefix;
  let lastSave = Date.now();
  let blockIndexHasText = false;

  const flush = async (force = false) => {
    if (!target.messageId || !target.channelId || pending.length === 0) return;
    if (!force && Date.now() - lastFlush < 150) return;
    const delta = pending;
    // Where this chunk starts in the message text: lets the UI apply chunks idempotently and notice a gap.
    const offset = liveText.length - pending.length;
    pending = '';
    lastFlush = Date.now();
    await publish(deps.ctx.sql, { type: 'message.delta', messageId: target.messageId, channelId: target.channelId, delta, offset });
    if (Date.now() - lastSave > 3000) {
      lastSave = Date.now();
      await deps.ctx.db.update(messages).set({ content: liveText, updatedAt: new Date() }).where(eq(messages.id, target.messageId));
    }
  };

  let q: Query | null = null;
  let stopping = false;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  /**
   * Ends the turn through an interrupt, so the CLI still writes its result with this attempt's
   * exact usage (a hard abort kills it without one). Hard abort if that fails or takes too long.
   */
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const interrupt = (q as Partial<Pick<Query, 'interrupt'>> | null)?.interrupt;
    if (!q || typeof interrupt !== 'function') {
      abort.abort();
      return;
    }
    hardStop = setTimeout(() => abort.abort(), STOP_GRACE_MS);
    interrupt.call(q).catch(() => abort.abort());
  };
  const onCancel = () => stop();

  try {
    q = deps.query({ prompt: prepared.input, options: prepared.options });
    if (cancel.aborted) stop();
    else cancel.addEventListener('abort', onCancel, { once: true });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (!sessionId && 'session_id' in msg && typeof msg.session_id === 'string') {
        sessionId = msg.session_id;
        // Saved right away: after a crash, the recovery resumes this session instead of replaying the request.
        await input.onSession(sessionId).catch((err) => deps.log.warn({ err, runId: rc.run.id }, 'could not save the session id early'));
      }
      switch (msg.type) {
        case 'stream_event': {
          if (msg.parent_tool_use_id !== null) break;
          const ev = msg.event as { type: string; delta?: { type: string; text?: string } };
          if (ev.type === 'message_start' && liveText.length > 0 && blockIndexHasText) {
            pending += '\n\n';
            liveText += '\n\n';
            blockIndexHasText = false;
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            pending += ev.delta.text;
            liveText += ev.delta.text;
            blockIndexHasText = true;
            await flush();
          }
          break;
        }
        case 'assistant': {
          if (msg.parent_tool_use_id !== null) break;
          sawAssistant = true;
          if (msg.error) {
            apiError = msg.error;
            if (msg.error === 'rate_limit' && source === 'subscription') {
              switchReason = 'limite de l’abonnement atteinte';
              await markSubscriptionLimited(deps.ctx, new Date(Date.now() + 30 * 60_000));
            } else if (msg.error === 'authentication_failed' || msg.error === 'oauth_org_not_allowed' || msg.error === 'account_on_hold') {
              await patchComputeState(deps.ctx, source === 'subscription' ? { subAuthFailed: true } : { apiAuthFailed: true });
              switchReason = source === 'subscription' ? 'jeton d’abonnement refusé' : 'clé API refusée';
            } else if (msg.error === 'billing_error' && source === 'api') {
              await patchComputeState(deps.ctx, { apiAuthFailed: true });
              switchReason = 'crédits API épuisés côté Anthropic';
            } else {
              error = `Erreur du modèle : ${msg.error}`;
            }
            if (switchReason) stop();
            break;
          }
          answered = true;
          const content =(msg.message as { content?: Array<{ type: string; text?: string; name?: string }> }).content ?? [];
          for (const block of content) {
            if (block.type === 'text' && block.text) textBlocks.push(block.text);
          }
          const u = (msg.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
          if (u) contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) || contextTokens;
          break;
        }
        case 'rate_limit_event': {
          const outcome = await recordRateLimitEvent(deps.ctx, msg.rate_limit_info as unknown as RateLimitInfo);
          await checkBudgetAlerts(deps, rc.settings);
          if (outcome.limited && source === 'subscription') {
            switchReason = `limite de l’abonnement atteinte${outcome.limitedUntil ? ` (réinitialisation ${outcome.limitedUntil.toLocaleTimeString('fr-CH', { timeZone: rc.settings.timezone, hour: '2-digit', minute: '2-digit' })})` : ''}`;
            stop();
          }
          break;
        }
        case 'result': {
          gotResult = true;
          totals = msg.modelUsage ?? null;
          // A turn we stopped ourselves: only its usage matters.
          if (stopping || switchReason) break;
          if (msg.subtype === 'success') {
            resultText = msg.result ?? '';
            if (msg.is_error) error = resultText || 'Erreur pendant l’exécution';
          } else if (msg.subtype === 'error_max_budget_usd') {
            error =
              source === 'api'
                ? 'Plafond de dépense de cette exécution atteint (crédits API). Relance-moi si tu veux que je continue.'
                : 'Plafond de cette exécution sur l’abonnement atteint (réglage « Plafond par exécution sur l’abonnement »). Relance-moi si tu veux que je continue.';
          } else if (msg.subtype === 'error_max_turns') {
            maxTurns = true;
            error = 'Nombre maximal d’étapes atteint pour cette exécution.';
          } else {
            error = msg.errors?.join(' ; ') || 'Erreur pendant l’exécution';
          }
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    // The SDK also throws right after an error result: the result's own reason is the one to keep.
    if (!abort.signal.aborted && !stopping && !gotResult) error = (err as Error).message;
  } finally {
    cancel.removeEventListener('abort', onCancel);
    if (hardStop) clearTimeout(hardStop);
  }
  await flush(true);

  const fresh = liveText.slice(prefix.length).trim();
  const text = textBlocks.join('\n\n').trim() || resultText.trim() || fresh;
  const base = { text, totals, sessionId, contextTokens, answered, apiError };
  if (switchReason) return { kind: 'switch', ...base, error: null, switchReason };
  if (stopping || abort.signal.aborted) return { kind: 'cancelled', ...base, error: 'Exécution annulée' };
  // Only a missing transcript justifies dropping the session; a crash or a kill at startup keeps it for the next message.
  if (error && !sawAssistant && prepared.options.resume && SESSION_NOT_FOUND.test(error)) return { kind: 'resume_failed', ...base, error };
  if (error) return { kind: 'failed', ...base, error, maxTurns };
  return { kind: 'completed', ...base, error: null };
}

async function accumulateUsage(deps: WorkerDeps, runId: string, usage: UsageRecord[], settings: AppSettings): Promise<void> {
  if (usage.length === 0) return;
  await recordUsage(deps.ctx, usage, settings.timezone);
  // Added in SQL: a one-off call made for this run (web_extract) may add its own cost at the same time.
  await addRunUsage(deps.ctx, runId, sumUsage(usage));
  await checkBudgetAlerts(deps, settings);
}

/** After a bot message in a group channel, @mentions of other members become hand-offs. */
async function handleMentions(deps: WorkerDeps, settings: AppSettings, run: RunRow, bot: BotRow, channel: ChannelRow, text: string): Promise<void> {
  if (channel.kind !== 'group' || !bot.permissions.handoff) return;
  const memberIds = await channelBotIds(deps.ctx, channel.id);
  const members = await deps.ctx.db.select({ id: bots.id, slug: bots.slug }).from(bots);
  // Bots this run already handed off to with the tool (in any attempt): naming them in the answer is not a second hand-off.
  const already = await deps.ctx.db
    .select({ botId: runs.botId })
    .from(runs)
    .where(and(eq(runs.chainId, run.chainId), dsql`${runs.payload}->>'handoffFromRunId' = ${run.id}`));
  const handedOff = new Set(already.map((r) => r.botId));
  const candidates = members.filter((m) => memberIds.includes(m.id) && m.id !== bot.id && !handedOff.has(m.id));
  const mentioned = extractMentions(text, candidates.map((c) => c.slug));
  for (const slug of mentioned) {
    const target = candidates.find((c) => c.slug === slug)!;
    await performHandoff(deps, settings, {
      fromRun: run,
      fromBot: { id: bot.id, slug: bot.slug, name: bot.name },
      toBotId: target.id,
      channelId: channel.id,
      threadRootId: run.threadRootId,
      task: text.length > 3000 ? `${text.slice(0, 3000)}…` : text,
      viaMention: true,
    });
  }
}

/** Runs one queued bot run end to end. */
export async function executeRun(deps: WorkerDeps, runId: string, externalSignal: AbortSignal): Promise<RunOutcome> {
  try {
    return await executeRunInner(deps, runId, externalSignal);
  } finally {
    // The run's real cost is recorded by now (or it never started): its API budget is free again.
    releaseApiBudget(runId);
  }
}

function isShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === SHUTDOWN_REASON;
}

async function executeRunInner(deps: WorkerDeps, runId: string, externalSignal: AbortSignal): Promise<RunOutcome> {
  const { ctx, log } = deps;
  const run = await getRun(ctx, runId);
  if (!run) return { outcome: 'cancelled' };
  if (TERMINAL.has(run.status)) {
    // Closed while its job waited (cancelled while queued or paused, superseded, closed as stranded): the feature
    // modules still learn its final state (handoff return…), once.
    await afterRunClosed(deps, run);
    return { outcome: 'cancelled' };
  }
  const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, run.botId) });
  if (!bot) return { outcome: 'cancelled' };
  if (bot.archivedAt || bot.paused) {
    await updateRun(ctx, run.id, { status: 'cancelled', error: 'bot en pause ou archivé', finishedAt: new Date(), activity: null });
    await afterRunClosed(deps, (await getRun(ctx, run.id)) ?? run, { bot });
    return { outcome: 'cancelled' };
  }
  const settings = await getSettings(ctx.db);
  const channel = run.channelId ? await channelOrNull(ctx, run.channelId) : null;
  if (run.channelId && !channel) {
    // Its conversation was archived while it waited: nobody would see the answer, and the bot should not act for it.
    await closeStrandedRun(ctx, run, 'cancelled', 'conversation archivée', '⚠️ Exécution annulée : conversation archivée.');
    await afterRunClosed(deps, (await getRun(ctx, run.id)) ?? run, { settings, bot, channel: null });
    return { outcome: 'cancelled' };
  }

  // A previous attempt was interrupted (worker restart, crash, uncaught error) or paused mid-turn:
  // if its SDK session already holds the request, continue it with a note instead of replaying it.
  const crashed = run.status === 'running';
  if (crashed && run.responseMessageId) {
    const prev = await getMessage(ctx, run.responseMessageId);
    if (prev && prev.status === 'streaming') {
      if (prev.content.trim()) {
        await updateMessage(ctx, prev.id, { status: 'done', content: `${prev.content}\n\n_(interrompu — reprise en cours)_` });
      } else {
        await ctx.db.delete(messages).where(eq(messages.id, prev.id));
        await publish(ctx.sql, { type: 'channel.updated', channelId: prev.channelId });
      }
    }
    await updateRun(ctx, run.id, { responseMessageId: null });
    run.responseMessageId = null;
  }
  const interruption = crashed || run.payload.restartResume ? 'restart' : run.payload.resumeAfterSwitch ? 'pause' : null;
  let resume: ResumeHint | null = null;
  let interruptedNote: string | null = null;
  if (interruption && run.sdkSessionId) {
    // Another run of the conversation may have used the session while this one waited (a later
    // message claimed first, a paused run's lane kept going): its last exchange is then not this
    // request, and a bare « reprends » would make the model finish the wrong task.
    if (await sessionStillOurs(ctx, run, run.sdkSessionId)) resume = { sessionId: run.sdkSessionId, note: RESUME_NOTES[interruption] };
    interruptedNote = INTERRUPTED_NOTES[interruption];
  }

  const request: DecisionRequest = { priority: run.priority, origin: run.origin, botId: bot.id, botDailyCapUsd: bot.apiDailyCapUsd };
  const reservation: BudgetReservation = { key: run.id };
  let decision: WorkerComputeDecision = await decideCompute(deps, request, settings, undefined, reservation);
  if (decision.source === 'paused') return pauseRun(deps, settings, run, decision);
  await clearAllPaused(deps);
  // The pending note is delivered by the first attempt below; a later interruption sets its own flag.
  if (run.payload.restartResume || run.payload.resumeAfterSwitch) {
    await patchRunPayload(ctx, run.id, { restartResume: false, resumeAfterSwitch: false });
  }

  let streamMessageId: string | null = null;
  let finalText = '';
  let finalError: string | null = null;
  let lastSource: ComputeSource = decision.source;
  let lastKind: AttemptResult['kind'] | null = null;
  let lostSession = false;
  let continueAfter = false;
  /** SDK session holding this run's request, once known. */
  let runSessionId: string | null = run.sdkSessionId;
  const outputs: RunOutputs = { attachments: [] };
  const silent = await isSilentRun(deps, run);

  /** Before leaving mid-run: keep partial text (with a note), drop an empty placeholder. */
  const settlePlaceholder = async (note: string) => {
    if (!streamMessageId) return;
    if (finalText.trim()) {
      await updateMessage(ctx, streamMessageId, { content: `${finalText}\n\n${note}`, status: 'done' });
    } else {
      await ctx.db.delete(messages).where(eq(messages.id, streamMessageId));
      await publish(ctx.sql, { type: 'channel.updated', channelId: channel?.id ?? '' });
    }
    await updateRun(ctx, run.id, { responseMessageId: null });
    streamMessageId = null;
  };

  const pauseMidRun = async (paused: WorkerComputeDecision & { source: 'paused' }): Promise<RunOutcome> => {
    await settlePlaceholder('_(interrompu : en attente d’une source de calcul, la suite viendra à la reprise)_');
    if (runSessionId) await patchRunPayload(ctx, run.id, { resumeAfterSwitch: true });
    return pauseRun(deps, settings, run, paused);
  };

  /** Worker stopping: back to the queue, resumed (session included) at the next start. */
  const deferForShutdown = async (): Promise<RunOutcome> => {
    await settlePlaceholder('_(interrompu par un redémarrage d’Ant — la suite arrive à la reprise)_');
    await patchRunPayload(ctx, run.id, { restartResume: true });
    await updateRun(ctx, run.id, { status: 'queued', activity: null });
    await publish(ctx.sql, { type: 'bot.updated', botId: bot.id });
    // Due at once and keeping its place in its lane: the messages sent after it must not run first.
    return { outcome: 'deferred', until: run.createdAt, reason: 'arrêt du worker : reprise au redémarrage' };
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // A stop that landed between two attempts (or during a switch): addEventListener on an
    // already-aborted signal would never fire.
    if (externalSignal.aborted) {
      if (isShutdown(externalSignal)) return deferForShutdown();
      finalError = CANCELLED;
      break;
    }
    if (decision.source === 'paused') return pauseMidRun(decision);
    const source: ComputeSource = decision.source;
    lastSource = source;
    const abort = new AbortController();

    await updateRun(ctx, run.id, {
      status: 'running',
      startedAt: run.startedAt ?? new Date(),
      computeSource: source,
      computeReason: decision.reason,
      activity: 'réfléchit',
    });
    await publish(ctx.sql, { type: 'bot.updated', botId: bot.id });

    // Text of earlier attempts stays in the message; this attempt's text follows it.
    const prefix = streamMessageId && finalText ? `${finalText}\n\n` : '';
    if (!streamMessageId && channel && !silent) {
      const m = await createMessage(ctx, {
        channelId: channel.id,
        threadRootId: run.threadRootId,
        authorKind: 'bot',
        botId: bot.id,
        content: '',
        status: 'streaming',
        runId: run.id,
        meta: {
          kind: 'chat',
          runId: run.id,
          model: run.model,
          effort: run.effort,
          computeSource: source,
          // Lets the conversation show which routine wrote this answer (manual and scheduled runs, and their follow-ups).
          ...(typeof run.payload.routineId === 'string' ? { routineId: run.payload.routineId } : {}),
        },
      });
      streamMessageId = m.id;
      await updateRun(ctx, run.id, { responseMessageId: m.id });
    } else if (streamMessageId) {
      await updateMessage(ctx, streamMessageId, { content: prefix, meta: { computeSource: source } });
    }

    const maxBudget = decision.source === 'api' ? decision.maxBudgetUsd : null;
    const prepared = await prepare(deps, run, bot, channel, settings, { source, maxBudgetUsd: maxBudget, abort, resume, lostSession, interruptedNote, outputs });
    const resumedFrom = prepared.options.resume ?? null;
    const result = await consume(deps, prepared, source, {
      target: { messageId: streamMessageId, channelId: channel?.id ?? null },
      abort,
      cancel: externalSignal,
      prefix,
      onSession: async (sessionId) => {
        runSessionId = sessionId;
        if (run.sdkSessionId !== sessionId) {
          await updateRun(ctx, run.id, { sdkSessionId: sessionId });
          run.sdkSessionId = sessionId;
        }
        // When this run last used the session: an interrupted run checks it before continuing with a note.
        await patchRunPayload(ctx, run.id, { sessionUsedAt: new Date().toISOString() });
        if (sessionId !== resumedFrom) {
          await ctx.db.update(agentSessions).set({ sdkSessionId: sessionId, updatedAt: new Date() }).where(eq(agentSessions.id, prepared.session.id));
        }
      },
    });

    // The SDK reports totals since the session began: record only this attempt's share.
    const baseline = resumedFrom ? await loadUsageBaseline(ctx, bot.id, resumedFrom) : null;
    await accumulateUsage(deps, run.id, usageDelta(result.totals, baseline, run, source), settings);

    // A session whose resume keeps failing before any answer, run after run, would block the
    // conversation for good (nothing else resets it): past the limit, it is dropped like a lost one.
    let sessionUnusable = false;
    if (resumedFrom && failedAtResume(result)) {
      const failures = (await previousResumeFailures(ctx, run, resumedFrom)) + 1;
      await patchRunPayload(ctx, run.id, { resumeFailure: { sdkSessionId: resumedFrom, count: failures } });
      sessionUnusable = failures >= RESUME_FAILURE_LIMIT;
    }
    lastKind = sessionUnusable ? 'resume_failed' : result.kind;

    if (result.kind === 'resume_failed' || sessionUnusable) {
      log.warn(
        { runId: run.id, error: result.error },
        sessionUnusable ? 'resumed session keeps failing, starting a fresh session' : 'resumed session not found, starting a fresh session',
      );
      await ctx.db.update(agentSessions).set({ sdkSessionId: null, updatedAt: new Date() }).where(eq(agentSessions.id, prepared.session.id));
      await updateRun(ctx, run.id, { sdkSessionId: null });
      run.sdkSessionId = null;
      runSessionId = null;
      // The fresh session gets the full request and the recent conversation, not a « reprends » note.
      lostSession = true;
      resume = null;
      continue;
    }
    if (result.sessionId) {
      const patch: Partial<typeof agentSessions.$inferInsert> = { sdkSessionId: result.sessionId, updatedAt: new Date() };
      if (result.contextTokens > 0) patch.approxTokens = result.contextTokens;
      if (prepared.contextAt) patch.lastSeenAt = prepared.contextAt;
      await ctx.db.update(agentSessions).set(patch).where(eq(agentSessions.id, prepared.session.id));
      if (run.sdkSessionId !== result.sessionId) {
        await updateRun(ctx, run.id, { sdkSessionId: result.sessionId });
        run.sdkSessionId = result.sessionId;
      }
      runSessionId = result.sessionId;
      // Zeroed totals (crash/startup results) must not replace a real baseline.
      if (result.totals && hasUsage(compactTotals(result.totals))) {
        await patchRunPayload(ctx, run.id, {
          usageTotals: { sdkSessionId: result.sessionId, at: new Date().toISOString(), models: compactTotals(result.totals) },
        });
      }
    }
    if (result.text) finalText = finalText ? `${finalText}\n\n${result.text}` : result.text;

    if (result.kind === 'switch') {
      if (externalSignal.aborted) {
        if (isShutdown(externalSignal)) return deferForShutdown();
        finalError = CANCELLED;
        break;
      }
      decision = await decideCompute(deps, request, settings, undefined, reservation);
      // A pause is announced by pauseRun(); only real switches get a message here.
      const note =
        decision.source === 'paused'
          ? null
          : `🔀 Bascule ${source === 'subscription' ? 'de l’abonnement' : 'des crédits API'} vers ${decision.source === 'api' ? 'les crédits API' : 'l’abonnement'} : ${result.switchReason}.`;
      if (channel && note) {
        await createMessage(ctx, { channelId: channel.id, threadRootId: run.threadRootId, authorKind: 'system', content: note, meta: { kind: 'compute_switch', runId: run.id } });
      }
      await audit(ctx.db, { actor: 'system', event: 'compute.switch', runId: run.id, detail: { from: source, to: decision.source, reason: result.switchReason } });
      // Only an attempt that really started a session can be continued with a note; otherwise the request is replayed.
      const sessionToContinue = result.sessionId ?? runSessionId;
      resume = sessionToContinue ? { sessionId: sessionToContinue, note: RESUME_NOTES.switch } : null;
      continue;
    }
    if (result.kind === 'cancelled') {
      if (isShutdown(externalSignal)) return deferForShutdown();
      finalError = CANCELLED;
      break;
    }
    if (result.kind === 'failed') {
      const done = Number(run.payload.continuation ?? 0);
      if (result.maxTurns && run.trigger !== 'heartbeat' && done < MAX_CONTINUATIONS) continueAfter = true;
      else if (result.maxTurns && run.trigger !== 'heartbeat') {
        finalError = `Nombre maximal d’étapes atteint, même après ${MAX_CONTINUATIONS} prolongations automatiques. Relance-moi si tu veux que je continue.`;
      } else finalError = result.error;
    }
    break;
  }

  // Attempts used up by switches or lost sessions: never report that as a successful empty answer.
  if (finalError === null && (lastKind === 'switch' || lastKind === 'resume_failed')) {
    if (decision.source === 'paused') return pauseMidRun(decision);
    finalError =
      lastKind === 'switch'
        ? 'Trop de bascules de source de calcul pendant cette exécution : relance la demande.'
        : 'La session de l’agent n’a pas pu démarrer après plusieurs essais : relance la demande.';
  }

  // Finalise.
  const latest = await getRun(ctx, run.id);
  const cost = latest?.costUsd ?? 0;
  const status = finalError === CANCELLED ? 'cancelled' : finalError ? 'error' : 'done';
  if (streamMessageId) {
    let content = finalText || (finalError || continueAfter ? '' : '_(pas de réponse)_');
    if (continueAfter) content = `${content}${content ? '\n\n' : ''}_(limite d’étapes atteinte : je continue dans une nouvelle exécution)_`;
    await updateMessage(ctx, streamMessageId, {
      content: finalError ? `${content}${content ? '\n\n' : ''}⚠️ ${finalError}` : content,
      status: finalError && !finalText ? 'error' : 'done',
      meta: {
        computeSource: lastSource,
        costUsd: cost,
        model: run.model,
        effort: run.effort,
        ...(outputs.attachments.length ? { attachments: outputs.attachments } : {}),
      },
    });
  }
  await updateRun(ctx, run.id, { status, error: finalError, finishedAt: new Date(), activity: null });
  await publish(ctx.sql, { type: 'bot.updated', botId: bot.id });
  await audit(ctx.db, {
    actor: botActor(bot.slug),
    event: 'run.finished',
    runId: run.id,
    detail: { trigger: run.trigger, model: modelLabel(run.model), effort: run.effort, source: lastSource, costUsd: cost, ...(continueAfter ? { continued: true } : {}) },
    outcome: status,
  });

  if (status === 'done' && channel && finalText) await handleMentions(deps, settings, run, bot, channel, finalText);
  const startedAt = chainStartedAt(latest ?? run);
  /** The follow-up run; null when none could start (bot paused or archived meanwhile): then the task is over here. */
  let continuation: Awaited<ReturnType<typeof requestRun>> = null;
  if (continueAfter) {
    // Same conversation, session and model: the follow-up resumes exactly where the step limit stopped this run,
    // and keeps what ties it to its origin (routine, handoff with return, followup, watch, draft) and when it began.
    const kept = Object.fromEntries(CONTINUATION_KEYS.filter((k) => run.payload[k] !== undefined).map((k) => [k, run.payload[k]]));
    continuation = await requestRun(ctx, {
      botId: bot.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      threadKey: run.threadKey,
      trigger: 'system',
      priority: run.priority,
      origin: run.origin,
      chainId: run.chainId,
      hop: run.hop,
      prompt: CONTINUATION_PROMPT,
      model: run.model,
      effort: run.effort,
      payload: {
        ...kept,
        continuation: Number(run.payload.continuation ?? 0) + 1,
        continuationOf: run.id,
        continuedTrigger: effectiveTrigger(run),
        chainStartedAt: startedAt.toISOString(),
      },
    });
  } else {
    await maybeRotate(deps, bot.id, run.threadKey, run.origin, settings);
  }
  await finishHooks(deps, settings, {
    run: (await getRun(ctx, run.id)) ?? run,
    bot,
    channel,
    status,
    trigger: effectiveTrigger(run),
    finalText,
    error: finalError,
    silent,
    responseMessageId: streamMessageId,
    attachments: outputs.attachments,
    startedAt,
    durationMs: Math.max(0, Date.now() - startedAt.getTime()),
    continued: continuation !== null,
  });
  return { outcome: status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'error' };
}

async function pauseRun(
  deps: WorkerDeps,
  settings: AppSettings,
  run: RunRow,
  decision: { reason: string; retryAt: Date | null },
): Promise<RunOutcome> {
  const { ctx } = deps;
  const { reason, retryAt } = decision;
  // Missing a heartbeat or a digest is harmless: drop it. Everything else waits for compute.
  if (run.trigger === 'heartbeat' || run.trigger === 'digest') {
    await updateRun(ctx, run.id, { status: 'cancelled', computeReason: reason, error: `non exécuté : ${reason}`, finishedAt: new Date(), activity: null });
    await afterRunClosed(deps, (await getRun(ctx, run.id)) ?? run, { settings });
    return { outcome: 'cancelled' };
  }
  // Autonomous work does not wait forever: replayed hours later it would act on stale instructions,
  // and runs piling up would all start at once when compute comes back.
  if (run.origin === 'autonomous' && Date.now() - run.createdAt.getTime() > STALE_AUTONOMOUS_MS) {
    const hours = STALE_AUTONOMOUS_MS / 3600_000;
    await updateRun(ctx, run.id, {
      status: 'cancelled',
      computeReason: reason,
      error: `non exécuté : aucune source de calcul pendant ${hours} h (${reason})`,
      finishedAt: new Date(),
      activity: null,
    });
    const content = `⏹️ Tâche autonome abandonnée après ${hours} h d’attente d’une source de calcul : ${reason}.`;
    // The ⏸️ notice already announced this outcome: it becomes the ⏹️ one rather than a second
    // message (a routine that can never run would otherwise post two notices per occurrence).
    const notice = typeof run.payload.pauseMessageId === 'string' ? await updateMessage(ctx, run.payload.pauseMessageId, { content }) : null;
    if (!notice && run.channelId && !run.payload.pauseNotified) {
      await createMessage(ctx, { channelId: run.channelId, threadRootId: run.threadRootId, authorKind: 'system', content, meta: { kind: 'compute_switch', runId: run.id } });
    }
    await audit(ctx.db, { actor: 'system', event: 'run.finished', runId: run.id, detail: { trigger: run.trigger, reason: `aucune source de calcul pendant ${hours} h : ${reason}` }, outcome: 'cancelled' });
    await publish(ctx.sql, { type: 'bot.updated', botId: run.botId });
    await afterRunClosed(deps, (await getRun(ctx, run.id)) ?? run, { settings });
    return { outcome: 'cancelled' };
  }
  const until = retryAt && retryAt.getTime() > Date.now() ? new Date(retryAt.getTime() + 60_000) : new Date(Date.now() + 15 * 60_000);
  await updateRun(ctx, run.id, { status: 'paused', computeReason: reason, activity: null });
  // Would the owner's own requests be paused too? Only then is Ant really « en pause ».
  const owner = await decideCompute(deps, { priority: 'interactive', origin: 'user', botId: null, botDailyCapUsd: null }, settings);
  if (run.channelId && !run.payload.pauseNotified) {
    const at = until.toLocaleTimeString('fr-CH', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' });
    const content =
      run.origin === 'autonomous' && owner.source !== 'paused' && !retryAt
        ? `⏸️ Tâche autonome en attente : ${reason}. Nouvel essai vers ${at} ; sans source de calcul d’ici ${STALE_AUTONOMOUS_MS / 3600_000} h, elle sera abandonnée (ajoute une clé API ou change de mode dans Quota & budget).`
        : `⏸️ Demande en attente : ${reason}. Reprise automatique vers ${at}.`;
    const notice = await createMessage(ctx, {
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      authorKind: 'system',
      content,
      meta: { kind: 'compute_switch', runId: run.id },
    });
    await patchRunPayload(ctx, run.id, { pauseNotified: true, pauseMessageId: notice.id });
  }
  // Urgent (through quiet hours) only when the owner is waiting for this answer; otherwise the notice waits for the morning.
  if (owner.source === 'paused' && !owner.heldByInFlight) await reportAllPaused(deps, settings, owner.reason, { urgent: run.origin === 'user' });
  return { outcome: 'deferred', until };
}

async function maybeRotate(deps: WorkerDeps, botId: string, threadKey: string, origin: RunOrigin, settings: AppSettings): Promise<void> {
  const session = await deps.ctx.db.query.agentSessions.findFirst({
    where: and(eq(agentSessions.botId, botId), eq(agentSessions.threadKey, threadKey), eq(agentSessions.active, true)),
  });
  if (session && session.approxTokens > settings.sessionRotateTokens) {
    // Hourly key: a rotation that failed or was paused is tried again after a later run, instead of
    // being blocked by its finished job until the 7-day purge. Rotating twice is harmless (inactive session).
    const bucket = Math.floor(Date.now() / 3600_000);
    await enqueue(
      deps.ctx.db,
      'session.rotate',
      { sessionId: session.id, origin },
      { dedupeKey: `rotate:${session.id}:${bucket}`, lane: `run:${botId}:${threadKey}`, maxAttempts: 1 },
    );
  }
}
