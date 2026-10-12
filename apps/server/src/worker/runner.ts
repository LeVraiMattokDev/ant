import type {
  AgentDefinition,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  ModelUsage,
  Options,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { and, asc, eq, gt, isNull, ne, sql as dsql } from 'drizzle-orm';
import {
  DEFAULT_BOT_PERMISSIONS,
  EFFORT_LABELS,
  SUBAGENT_TIERS,
  extractMentions,
  localDateKey,
  modelLabel,
  type AppSettings,
  type BotPermissions,
  type ComputeSource,
  type SubagentTier,
} from '@ant/shared';
import { agentSessions, auditLog, bots, messages } from '../db/schema';
import { audit, botActor } from '../lib/audit';
import { getSettings } from '../lib/settings';
import { activeBots, type BotRow } from '../services/bots';
import { channelBotIds, getChannel, type ChannelRow } from '../services/channels';
import { createMessage, getMessage, recentTranscript, updateMessage } from '../services/messages';
import { pinnedMemoryBlock } from '../services/memory';
import { markSubscriptionLimited, patchComputeState, recordRateLimitEvent, recordUsage, type RateLimitInfo, type UsageRecord } from '../services/quota';
import { getRun, updateRun, type RunRow } from '../services/runs';
import { openTasksSummary } from '../services/tasks';
import { publish } from '../lib/events';
import { enqueue } from '../lib/jobs';
import { checkBudgetAlerts, clearAllPaused, reportAllPaused } from './alerts';
import { buildAgentEnv, decideCompute } from './compute';
import type { WorkerDeps } from './deps';
import { performHandoff } from './handoff';
import { SUBAGENT_PROMPTS, dynamicSystemPrompt, staticSystemPrompt, systemPromptParts } from './prompt';
import type { RunContext } from './run-context';
import { LIGHT_SUBAGENT_TOOLS, createAntServer, mcpToolName } from './tools';

export type RunOutcome = { outcome: 'done' | 'cancelled' | 'error' } | { outcome: 'deferred'; until: Date };

const TERMINAL = new Set(['done', 'cancelled', 'error']);

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
  return TOOL_ACTIVITY[short] ?? `utilise ${short}`;
}

function describeTrigger(run: RunRow): string {
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
    default:
      return 'système';
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

/** Messages other participants wrote in this conversation since the bot last spoke. */
async function unseenMessages(deps: WorkerDeps, run: RunRow, session: SessionRow, names: Map<string, string>): Promise<string> {
  if (!run.channelId) return '';
  const { db } = deps.ctx;
  const scope = run.threadRootId
    ? dsql`(${messages.id} = ${run.threadRootId} or ${messages.threadRootId} = ${run.threadRootId})`
    : and(eq(messages.channelId, run.channelId), isNull(messages.threadRootId));
  if (!session.lastSeenAt) {
    if (run.trigger === 'user' && !run.threadRootId) return '';
    return recentTranscript(deps.ctx, run.channelId, run.threadRootId, 20, names);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        scope,
        gt(messages.createdAt, session.lastSeenAt),
        ne(messages.status, 'streaming'),
        dsql`(${messages.botId} is null or ${messages.botId} <> ${run.botId} or ${messages.authorKind} = 'system')`,
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(40);
  return rows
    .filter((r) => !(r.authorKind === 'user' && r.content === run.prompt))
    .map((r) => {
      const who = r.authorKind === 'user' ? 'Propriétaire' : r.authorKind === 'system' ? 'Système' : `@${names.get(r.botId ?? '') ?? 'bot'}`;
      return `[${r.createdAt.toISOString().slice(0, 16)}] ${who} : ${r.content}`;
    })
    .join('\n');
}

function buildPrompt(run: RunRow, unseen: string): string {
  const head = unseen ? `Nouveaux messages dans la conversation depuis ta dernière intervention :\n${unseen}\n\n---\n` : '';
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
  usage: UsageRecord[];
  sessionId: string | null;
  contextTokens: number;
  switchReason?: string;
}

function usageFromModelUsage(modelUsage: Record<string, ModelUsage> | undefined, runId: string, botId: string, source: ComputeSource): UsageRecord[] {
  if (!modelUsage) return [];
  return Object.entries(modelUsage).map(([model, u]) => ({
    runId,
    botId,
    source,
    model: u.canonicalModel ?? model,
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadInputTokens ?? 0,
    cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
    costUsd: u.costUSD ?? 0,
  }));
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

export interface PreparedRun {
  rc: RunContext;
  options: Options;
  prompt: string;
  session: SessionRow;
}

async function prepare(
  deps: WorkerDeps,
  run: RunRow,
  bot: BotRow,
  channel: ChannelRow | null,
  settings: AppSettings,
  source: ComputeSource,
  maxBudgetUsd: number | null,
  abort: AbortController,
  resumeNote: string | null,
): Promise<PreparedRun> {
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

  const staticPart = staticSystemPrompt({
    bot,
    permissions,
    otherBots: all.filter((b) => b.id !== bot.id).map((b) => ({ slug: b.slug, name: b.name, role: b.role })),
    pinnedMemory: await pinnedMemoryBlock(deps.ctx, bot.id),
  });
  const dynamicPart = dynamicSystemPrompt({
    now: new Date(),
    timezone: settings.timezone,
    channelDescription,
    triggerDescription: describeTrigger(run),
    openTasks: await openTasksSummary(deps.ctx, bot.id),
    sessionSummary: session.sdkSessionId ? null : session.summary,
  });

  // Heartbeats are self-contained (their prompt carries the context): no unseen messages, no resume.
  const isHeartbeat = run.trigger === 'heartbeat';
  const unseen = isHeartbeat ? '' : await unseenMessages(deps, run, session, names);
  const prompt = resumeNote ?? buildPrompt(run, unseen);

  const options: Options = {
    model: run.model,
    effort: run.effort,
    systemPrompt: systemPromptParts(staticPart, dynamicPart),
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
    maxTurns: run.trigger === 'heartbeat' ? 15 : 80,
    ...(session.sdkSessionId && !isHeartbeat ? { resume: session.sdkSessionId } : {}),
    ...(source === 'api' && maxBudgetUsd !== null ? { maxBudgetUsd } : {}),
    ...(deps.cfg.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: deps.cfg.CLAUDE_CODE_EXECUTABLE } : {}),
  };
  return { rc, options, prompt, session };
}

interface StreamTarget {
  messageId: string | null;
  channelId: string | null;
}

/** Consumes the SDK message stream of one attempt. */
async function consume(
  deps: WorkerDeps,
  prepared: PreparedRun,
  source: ComputeSource,
  target: StreamTarget,
  abort: AbortController,
): Promise<AttemptResult> {
  const { rc } = prepared;
  const { run } = rc;
  const textBlocks: string[] = [];
  let resultText = '';
  let error: string | null = null;
  let usage: UsageRecord[] = [];
  let sessionId: string | null = null;
  let contextTokens = 0;
  let switchReason: string | undefined;
  let sawAssistant = false;
  let pending = '';
  let lastFlush = Date.now();
  let liveText = '';
  let lastSave = Date.now();
  let blockIndexHasText = false;

  const flush = async (force = false) => {
    if (!target.messageId || !target.channelId || pending.length === 0) return;
    if (!force && Date.now() - lastFlush < 150) return;
    const delta = pending;
    pending = '';
    lastFlush = Date.now();
    await publish(deps.ctx.sql, { type: 'message.delta', messageId: target.messageId, channelId: target.channelId, delta });
    if (Date.now() - lastSave > 3000) {
      lastSave = Date.now();
      await deps.ctx.db.update(messages).set({ content: liveText, updatedAt: new Date() }).where(eq(messages.id, target.messageId));
    }
  };

  const q = deps.query({ prompt: prepared.prompt, options: prepared.options });
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (!sessionId && 'session_id' in msg && typeof msg.session_id === 'string') sessionId = msg.session_id;
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
            if (switchReason) abort.abort();
            break;
          }
          const content = (msg.message as { content?: Array<{ type: string; text?: string; name?: string }> }).content ?? [];
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
            abort.abort();
          }
          break;
        }
        case 'result': {
          usage = usageFromModelUsage(msg.modelUsage, run.id, rc.bot.id, source);
          if (msg.subtype === 'success') {
            resultText = msg.result ?? '';
            if (msg.is_error && !switchReason) error = resultText || 'Erreur pendant l’exécution';
          } else if (msg.subtype === 'error_max_budget_usd') {
            error = 'Plafond de dépense de cette exécution atteint (crédits API). Relance-moi si tu veux que je continue.';
          } else if (msg.subtype === 'error_max_turns') {
            error = 'Nombre maximal d’étapes atteint pour cette exécution.';
          } else if (!switchReason) {
            error = msg.errors?.join(' ; ') || 'Erreur pendant l’exécution';
          }
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) error = (err as Error).message;
  }
  await flush(true);

  const text = textBlocks.join('\n\n').trim() || resultText.trim() || liveText.trim();
  if (switchReason) return { kind: 'switch', text, error: null, usage, sessionId, contextTokens, switchReason };
  if (abort.signal.aborted) return { kind: 'cancelled', text, error: 'Exécution annulée', usage, sessionId, contextTokens };
  if (error && !sawAssistant && prepared.options.resume) return { kind: 'resume_failed', text, error, usage, sessionId, contextTokens };
  if (error) return { kind: 'failed', text, error, usage, sessionId, contextTokens };
  return { kind: 'completed', text, error: null, usage, sessionId, contextTokens };
}

async function accumulateUsage(deps: WorkerDeps, runId: string, usage: UsageRecord[], settings: AppSettings): Promise<void> {
  if (usage.length === 0) return;
  await recordUsage(deps.ctx, usage, settings.timezone);
  const run = await getRun(deps.ctx, runId);
  if (!run) return;
  const sum = (k: keyof UsageRecord) => usage.reduce((acc, u) => acc + (Number(u[k]) || 0), 0);
  await updateRun(deps.ctx, runId, {
    costUsd: run.costUsd + sum('costUsd'),
    inputTokens: run.inputTokens + sum('inputTokens'),
    outputTokens: run.outputTokens + sum('outputTokens'),
    cacheReadTokens: run.cacheReadTokens + sum('cacheReadTokens'),
    cacheWriteTokens: run.cacheWriteTokens + sum('cacheWriteTokens'),
  });
  await checkBudgetAlerts(deps, settings);
}

/** After a bot message in a group channel, @mentions of other members become hand-offs. */
async function handleMentions(deps: WorkerDeps, settings: AppSettings, run: RunRow, bot: BotRow, channel: ChannelRow, text: string): Promise<void> {
  if (channel.kind !== 'group' || !bot.permissions.handoff) return;
  const memberIds = await channelBotIds(deps.ctx, channel.id);
  const members = await deps.ctx.db.select({ id: bots.id, slug: bots.slug }).from(bots);
  const candidates = members.filter((m) => memberIds.includes(m.id) && m.id !== bot.id);
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
  const { ctx, log } = deps;
  const run = await getRun(ctx, runId);
  if (!run || TERMINAL.has(run.status)) return { outcome: 'cancelled' };
  const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, run.botId) });
  if (!bot || bot.archivedAt || bot.paused) {
    await updateRun(ctx, run.id, { status: 'cancelled', error: 'bot en pause ou archivé', finishedAt: new Date(), activity: null });
    return { outcome: 'cancelled' };
  }
  const settings = await getSettings(ctx.db);
  const channel = run.channelId ? await getChannel(ctx, run.channelId).catch(() => null) : null;

  // Crash recovery: a previous attempt left a streaming message behind.
  if (run.status === 'running' && run.responseMessageId) {
    const prev = await getMessage(ctx, run.responseMessageId);
    if (prev && prev.status === 'streaming') {
      await updateMessage(ctx, prev.id, { status: 'error', content: `${prev.content}\n\n_(interrompu par un redémarrage d’Ant — reprise en cours)_` });
    }
    await updateRun(ctx, run.id, { responseMessageId: null });
    run.responseMessageId = null;
  }

  let decision = await decideCompute(deps, { priority: run.priority, origin: run.origin, botId: bot.id, botDailyCapUsd: bot.apiDailyCapUsd }, settings);
  if (decision.source === 'paused') return pauseRun(deps, settings, run, decision.reason, decision.retryAt);
  await clearAllPaused(deps);

  let resumeNote: string | null = null;
  let streamMessageId: string | null = null;
  let finalText = '';
  let finalError: string | null = null;
  let lastSource: ComputeSource = decision.source;

  /** Before pausing mid-run: keep partial text, drop an empty placeholder. */
  const settlePlaceholder = async () => {
    if (!streamMessageId) return;
    if (finalText.trim()) {
      await updateMessage(ctx, streamMessageId, { content: `${finalText}\n\n_(interrompu : en attente d’une source de calcul, la suite viendra à la reprise)_`, status: 'done' });
    } else {
      await ctx.db.delete(messages).where(eq(messages.id, streamMessageId));
      await publish(ctx.sql, { type: 'channel.updated', channelId: channel?.id ?? '' });
    }
    await updateRun(ctx, run.id, { responseMessageId: null });
    streamMessageId = null;
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (decision.source === 'paused') {
      await settlePlaceholder();
      return pauseRun(deps, settings, run, decision.reason, decision.retryAt);
    }
    const source: ComputeSource = decision.source;
    lastSource = source;
    const abort = new AbortController();
    const onExternalAbort = () => abort.abort();
    externalSignal.addEventListener('abort', onExternalAbort);

    await updateRun(ctx, run.id, {
      status: 'running',
      startedAt: run.startedAt ?? new Date(),
      computeSource: source,
      computeReason: decision.reason,
      activity: 'réfléchit',
    });
    await publish(ctx.sql, { type: 'bot.updated', botId: bot.id });

    if (!streamMessageId && channel && run.trigger !== 'heartbeat') {
      const m = await createMessage(ctx, {
        channelId: channel.id,
        threadRootId: run.threadRootId,
        authorKind: 'bot',
        botId: bot.id,
        content: '',
        status: 'streaming',
        runId: run.id,
        meta: { kind: 'chat', runId: run.id, model: run.model, effort: run.effort, computeSource: source },
      });
      streamMessageId = m.id;
      await updateRun(ctx, run.id, { responseMessageId: m.id });
    } else if (streamMessageId) {
      await updateMessage(ctx, streamMessageId, { meta: { computeSource: source } });
    }

    const maxBudget = decision.source === 'api' ? decision.maxBudgetUsd : null;
    const prepared = await prepare(deps, run, bot, channel, settings, source, maxBudget, abort, resumeNote);
    let result: AttemptResult;
    try {
      result = await consume(deps, prepared, source, { messageId: streamMessageId, channelId: channel?.id ?? null }, abort);
    } finally {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
    await accumulateUsage(deps, run.id, result.usage, settings);
    if (result.sessionId) {
      await ctx.db
        .update(agentSessions)
        .set({ sdkSessionId: result.sessionId, approxTokens: result.contextTokens, lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(agentSessions.id, prepared.session.id));
      await updateRun(ctx, run.id, { sdkSessionId: result.sessionId });
    }
    if (result.text) finalText = finalText ? `${finalText}\n\n${result.text}` : result.text;

    if (result.kind === 'resume_failed') {
      log.warn({ runId: run.id, error: result.error }, 'resume failed, starting a fresh session');
      await ctx.db.update(agentSessions).set({ sdkSessionId: null, updatedAt: new Date() }).where(eq(agentSessions.id, prepared.session.id));
      continue;
    }
    if (result.kind === 'switch') {
      decision = await decideCompute(deps, { priority: run.priority, origin: run.origin, botId: bot.id, botDailyCapUsd: bot.apiDailyCapUsd }, settings);
      // A pause is announced by pauseRun(); only real switches get a message here.
      const note =
        decision.source === 'paused'
          ? null
          : `🔀 Bascule ${source === 'subscription' ? 'de l’abonnement' : 'des crédits API'} vers ${decision.source === 'api' ? 'les crédits API' : 'l’abonnement'} : ${result.switchReason}.`;
      if (channel && note) {
        await createMessage(ctx, { channelId: channel.id, threadRootId: run.threadRootId, authorKind: 'system', content: note, meta: { kind: 'compute_switch', runId: run.id } });
      }
      await audit(ctx.db, { actor: 'system', event: 'compute.switch', runId: run.id, detail: { from: source, to: decision.source, reason: result.switchReason } });
      resumeNote = 'Ta réponse précédente a été interrompue par un changement de source de calcul. Reprends exactement là où tu en étais et termine la tâche.';
      continue;
    }
    if (result.kind === 'cancelled') {
      finalError = 'Exécution annulée.';
      break;
    }
    if (result.kind === 'failed') finalError = result.error;
    break;
  }

  // Finalise.
  const latest = await getRun(ctx, run.id);
  const cost = latest?.costUsd ?? 0;
  const status = finalError === 'Exécution annulée.' ? 'cancelled' : finalError ? 'error' : 'done';
  if (streamMessageId) {
    const content = finalText || (finalError ? '' : '_(pas de réponse)_');
    await updateMessage(ctx, streamMessageId, {
      content: finalError ? `${content}${content ? '\n\n' : ''}⚠️ ${finalError}` : content,
      status: finalError && !finalText ? 'error' : 'done',
      meta: { computeSource: lastSource, costUsd: cost, model: run.model, effort: run.effort },
    });
  }
  await updateRun(ctx, run.id, { status, error: finalError, finishedAt: new Date(), activity: null });
  await publish(ctx.sql, { type: 'bot.updated', botId: bot.id });
  await audit(ctx.db, {
    actor: botActor(bot.slug),
    event: 'run.finished',
    runId: run.id,
    detail: { trigger: run.trigger, model: modelLabel(run.model), effort: run.effort, source: lastSource, costUsd: cost },
    outcome: status,
  });

  if (status === 'done' && channel && finalText) await handleMentions(deps, settings, run, bot, channel, finalText);
  await maybeRotate(deps, bot.id, run.threadKey, settings);
  return { outcome: status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'error' };
}

async function pauseRun(deps: WorkerDeps, settings: AppSettings, run: RunRow, reason: string, retryAt: Date | null): Promise<RunOutcome> {
  const { ctx } = deps;
  // Missing a heartbeat or a digest is harmless: drop it. Everything else waits for compute.
  if (run.trigger === 'heartbeat' || run.trigger === 'digest') {
    await updateRun(ctx, run.id, { status: 'cancelled', computeReason: reason, error: `non exécuté : ${reason}`, finishedAt: new Date(), activity: null });
    return { outcome: 'cancelled' };
  }
  const until = retryAt && retryAt.getTime() > Date.now() ? new Date(retryAt.getTime() + 60_000) : new Date(Date.now() + 15 * 60_000);
  await updateRun(ctx, run.id, { status: 'paused', computeReason: reason, activity: null });
  if (run.channelId && !run.payload.pauseNotified) {
    await createMessage(ctx, {
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      authorKind: 'system',
      content: `⏸️ Demande en attente : ${reason}. Reprise automatique vers ${until.toLocaleTimeString('fr-CH', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' })}.`,
      meta: { kind: 'compute_switch', runId: run.id },
    });
    await updateRun(ctx, run.id, { payload: { ...run.payload, pauseNotified: true } });
  }
  await reportAllPaused(deps, settings, reason);
  return { outcome: 'deferred', until };
}

async function maybeRotate(deps: WorkerDeps, botId: string, threadKey: string, settings: AppSettings): Promise<void> {
  const session = await deps.ctx.db.query.agentSessions.findFirst({
    where: and(eq(agentSessions.botId, botId), eq(agentSessions.threadKey, threadKey), eq(agentSessions.active, true)),
  });
  if (session && session.approxTokens > settings.sessionRotateTokens) {
    await enqueue(deps.ctx.db, 'session.rotate', { sessionId: session.id }, { dedupeKey: `rotate:${session.id}`, lane: `run:${botId}:${threadKey}` });
  }
}
