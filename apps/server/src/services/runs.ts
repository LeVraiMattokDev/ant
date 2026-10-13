import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, sql as dsql } from 'drizzle-orm';
import { extractMentions, type EffortLevel, type MessageDTO, type RunDTO, type RunOrigin, type RunPriority, type RunTrigger } from '@ant/shared';
import { bots, jobs, messages, runs, type RunPayload } from '../db/schema';
import { audit } from '../lib/audit';
import { runToDTO } from '../lib/dto';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import { enqueue } from '../lib/jobs';
import { channelBotIds, getChannel, type ChannelRow } from './channels';
import type { Ctx } from './context';
import { createMessage, updateMessage } from './messages';

export const CONTROL_CHANNEL = 'ant_control';

export type RunRow = typeof runs.$inferSelect;

export interface RunRequest {
  botId: string;
  channelId: string | null;
  threadRootId: string | null;
  trigger: RunTrigger;
  priority: RunPriority;
  origin: RunOrigin;
  prompt: string;
  chainId?: string;
  hop?: number;
  payload?: RunPayload;
  runAt?: Date;
  /** Overrides the conversation key (default: channel or channel:thread). */
  threadKey?: string;
  /** One-off model and effort for this run only (« Approfondir »); default: the bot's. */
  model?: string;
  effort?: EffortLevel;
}

/** One-off model choice applied to the runs a message starts (PostMessageInput.depth). */
export interface RunOverrides {
  model?: string;
  effort?: EffortLevel;
  payload?: RunPayload;
}

/** Every run trigger (a Record, so that adding a trigger to RunTrigger without listing it here fails to compile). */
const RUN_TRIGGERS: Record<RunTrigger, true> = {
  user: true,
  mention: true,
  handoff: true,
  heartbeat: true,
  routine: true,
  digest: true,
  approval: true,
  system: true,
  followup: true,
  watch: true,
  draft: true,
};

/**
 * What really started the work a run does: its trigger, or for an automatic continuation (step limit reached, trigger
 * `system`) the trigger of the run it continues (`payload.continuedTrigger`). Rules about a run's origin (completion
 * push, cost by origin) use this, never `run.trigger` alone: the last run of a long task is a continuation.
 */
export function effectiveTrigger(run: Pick<RunRow, 'trigger' | 'payload'>): RunTrigger {
  const continued = run.payload.continuedTrigger;
  return typeof continued === 'string' && Object.hasOwn(RUN_TRIGGERS, continued) ? (continued as RunTrigger) : run.trigger;
}

/**
 * When the work of a run started: its own first start, or for an automatic continuation the first start of the
 * first run of the chain (`payload.chainStartedAt`). A ten-minute task continued twice lasts ten minutes, not the
 * duration of its last piece.
 */
export function chainStartedAt(run: Pick<RunRow, 'payload' | 'startedAt' | 'createdAt'>): Date {
  const raw = run.payload.chainStartedAt;
  const first = typeof raw === 'string' ? new Date(raw) : null;
  return first && !Number.isNaN(first.getTime()) ? first : (run.startedAt ?? run.createdAt);
}

export function threadKeyFor(channelId: string | null, threadRootId: string | null): string {
  if (!channelId) return 'none';
  return threadRootId ? `${channelId}:${threadRootId}` : channelId;
}

export async function requestRun(ctx: Ctx, req: RunRequest): Promise<RunDTO | null> {
  const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, req.botId) });
  if (!bot || bot.archivedAt) return null;
  if (bot.paused) return null;
  const threadKey = req.threadKey ?? threadKeyFor(req.channelId, req.threadRootId);
  const [row] = await ctx.db
    .insert(runs)
    .values({
      botId: bot.id,
      channelId: req.channelId,
      threadRootId: req.threadRootId,
      threadKey,
      trigger: req.trigger,
      priority: req.priority,
      origin: req.origin,
      chainId: req.chainId ?? randomUUID(),
      hop: req.hop ?? 0,
      model: req.model ?? bot.model,
      effort: req.effort ?? bot.effort,
      prompt: req.prompt,
      payload: req.payload ?? {},
    })
    .returning();
  if (!row) throw new Error('insert run failed');
  await enqueue(ctx.db, 'bot.run', { runId: row.id }, { lane: `run:${bot.id}:${threadKey}`, runAt: req.runAt, maxAttempts: 2 });
  const dto = runToDTO(row);
  await publish(ctx.sql, { type: 'run.updated', run: dto });
  return dto;
}

export async function getRun(ctx: Ctx, id: string): Promise<RunRow | undefined> {
  return ctx.db.query.runs.findFirst({ where: eq(runs.id, id) });
}

export async function updateRun(ctx: Ctx, id: string, patch: Partial<typeof runs.$inferInsert>): Promise<RunDTO | null> {
  const [row] = await ctx.db.update(runs).set(patch).where(eq(runs.id, id)).returning();
  if (!row) return null;
  const dto = runToDTO(row);
  await publish(ctx.sql, { type: 'run.updated', run: dto });
  return dto;
}

export async function listRecentRuns(ctx: Ctx, limit = 50, botId?: string): Promise<RunDTO[]> {
  const rows = await ctx.db
    .select()
    .from(runs)
    .where(botId ? eq(runs.botId, botId) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(Math.min(limit, 200));
  return rows.map(runToDTO);
}

export async function activeRuns(ctx: Ctx): Promise<RunDTO[]> {
  const rows = await ctx.db
    .select()
    .from(runs)
    .where(inArray(runs.status, ['queued', 'running', 'waiting_approval']))
    .orderBy(desc(runs.createdAt))
    .limit(100);
  return rows.map(runToDTO);
}

/**
 * Merges keys into a run's payload in SQL, so concurrent writers (the runner, pause bookkeeping)
 * never overwrite each other's keys with a stale copy.
 */
export async function patchRunPayload(ctx: Ctx, id: string, patch: RunPayload): Promise<void> {
  await ctx.db
    .update(runs)
    .set({ payload: dsql`${runs.payload} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(runs.id, id));
}

/** Tokens and estimated cost to add to a run's totals. */
export interface RunUsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Adds usage to a run's totals in SQL (RunDTO.costUsd, tokens): the run's own model calls and the one-off calls made
 * on its behalf (web_extract…) may be recorded at the same time without losing either.
 */
export async function addRunUsage(ctx: Ctx, runId: string, usage: RunUsageTotals): Promise<RunDTO | null> {
  const [row] = await ctx.db
    .update(runs)
    .set({
      costUsd: dsql`${runs.costUsd} + ${usage.costUsd}`,
      inputTokens: dsql`${runs.inputTokens} + ${Math.round(usage.inputTokens)}`,
      outputTokens: dsql`${runs.outputTokens} + ${Math.round(usage.outputTokens)}`,
      cacheReadTokens: dsql`${runs.cacheReadTokens} + ${Math.round(usage.cacheReadTokens)}`,
      cacheWriteTokens: dsql`${runs.cacheWriteTokens} + ${Math.round(usage.cacheWriteTokens)}`,
    })
    .where(eq(runs.id, runId))
    .returning();
  if (!row) return null;
  const dto = runToDTO(row);
  await publish(ctx.sql, { type: 'run.updated', run: dto });
  return dto;
}

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'error']);

/**
 * A run closed while its bot.run job still waits in the queue (cancelled while queued or paused, superseded): the job
 * is made due now, so the worker picks it up at once, sees the final state and runs the afterRun hooks of the feature
 * modules (handoff return, …) instead of hours later when a paused run's retry time comes.
 */
export async function expediteRunJob(ctx: Ctx, runId: string): Promise<void> {
  await ctx.db
    .update(jobs)
    .set({ runAt: new Date() })
    .where(and(eq(jobs.kind, 'bot.run'), eq(jobs.status, 'pending'), dsql`${jobs.payload}->>'runId' = ${runId}`));
}

/** True while a worker is executing this run's job (only then can a NOTIFY reach its AbortController). */
async function runJobIsRunning(ctx: Ctx, runId: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, 'bot.run'), eq(jobs.status, 'running'), dsql`${jobs.payload}->>'runId' = ${runId}`))
    .limit(1);
  return rows.length > 0;
}

/**
 * Closes a run that no worker is executing any more (its job failed for good, or vanished):
 * streaming placeholders get a final note and the run its final status, so the bot no longer
 * shows as « réfléchit » forever.
 */
export async function closeStrandedRun(ctx: Ctx, run: RunRow, status: 'error' | 'cancelled', error: string, note: string): Promise<void> {
  const streaming = await ctx.db.select().from(messages).where(and(eq(messages.runId, run.id), eq(messages.status, 'streaming')));
  for (const m of streaming) {
    const partial = m.content.trim();
    await updateMessage(ctx, m.id, { status: partial ? 'done' : 'error', content: partial ? `${m.content}\n\n${note}` : note });
  }
  await updateRun(ctx, run.id, { status, error, finishedAt: new Date(), activity: null });
  await publish(ctx.sql, { type: 'bot.updated', botId: run.botId });
  await audit(ctx.db, { actor: 'system', event: 'run.finished', runId: run.id, detail: { trigger: run.trigger, reason: error }, outcome: status });
}

/**
 * The bot.run job failed for good (uncaught error on its last attempt): record the failure on the run. Returns the
 * closed run (null when it was already over), for the worker to run the afterRun hooks.
 */
export async function failRun(ctx: Ctx, runId: string, reason: string): Promise<RunRow | null> {
  const run = await getRun(ctx, runId);
  if (!run || TERMINAL_STATUSES.has(run.status)) return null;
  const short = reason.split('\n')[0]!.slice(0, 300);
  await closeStrandedRun(ctx, run, 'error', `Erreur interne : ${reason.slice(0, 2000)}`, `⚠️ Erreur interne : ${short}`);
  return (await getRun(ctx, runId)) ?? null;
}

/**
 * Runs left queued, running or paused without any pending or running job (job failed, purged, or the
 * worker died between two writes) would stay active forever: close them. `graceMs` covers the gap
 * between inserting a run and enqueuing its job.
 */
export async function sweepOrphanRuns(
  ctx: Ctx,
  now = new Date(),
  graceMs = 2 * 60_000,
  /** Called with each closed run (the worker runs the afterRun hooks: no job will ever pick these runs up). */
  onClosed?: (run: RunRow) => Promise<void>,
): Promise<number> {
  const orphans = await ctx.db
    .select()
    .from(runs)
    .where(
      and(
        inArray(runs.status, ['queued', 'running', 'paused']),
        lt(runs.createdAt, new Date(now.getTime() - graceMs)),
        dsql`not exists (select 1 from ${jobs} j where j.kind = 'bot.run' and j.status in ('pending', 'running') and j.payload->>'runId' = ${runs.id}::text)`,
      ),
    )
    .limit(100);
  for (const run of orphans) {
    await closeStrandedRun(ctx, run, 'error', 'exécution orpheline : plus aucun travail en file pour elle', '⚠️ Exécution interrompue : elle n’était plus suivie par le worker. Relance la demande si besoin.');
    if (onClosed) {
      const closed = await getRun(ctx, run.id);
      if (closed) await onClosed(closed);
    }
  }
  return orphans.length;
}

export async function cancelRun(ctx: Ctx, id: string): Promise<void> {
  const run = await getRun(ctx, id);
  if (!run) throw new HttpError(404, 'not_found', 'Exécution introuvable.');
  if (run.status === 'queued' || run.status === 'paused') {
    await updateRun(ctx, id, { status: 'cancelled', finishedAt: new Date(), activity: null });
    await expediteRunJob(ctx, id);
  } else if (run.status === 'running' && !(await runJobIsRunning(ctx, id))) {
    // No live AbortController for it (job waiting for a retry, or failed for good): the NOTIFY alone would do nothing.
    await closeStrandedRun(ctx, run, 'cancelled', 'Exécution annulée.', '⚠️ Exécution annulée.');
    await expediteRunJob(ctx, id);
  }
  await ctx.sql.notify(CONTROL_CHANNEL, JSON.stringify({ type: 'cancel', runId: id }));
}

/** Who answers a message the owner posted, and as what trigger (see resolveMessageTargets). */
export interface MessageTargets {
  channel: ChannelRow;
  /** Bots to run, in order; empty only for a group channel without any bot. */
  botIds: string[];
  trigger: Extract<RunTrigger, 'user' | 'mention'>;
}

/**
 * Decides which bots answer a message the owner posted (the single source of this rule: dispatchUserMessage, and
 * whatever must check those bots beforehand, e.g. their permission for a one-off expert model).
 * - DM: the bot of the DM.
 * - Group: the @mentioned members; otherwise the bots already in the thread; otherwise the first member.
 */
export async function resolveMessageTargets(ctx: Ctx, message: Pick<MessageDTO, 'channelId' | 'threadRootId' | 'content'>): Promise<MessageTargets> {
  const channel = await getChannel(ctx, message.channelId);
  if (channel.kind === 'dm' && channel.dmBotId) return { channel, botIds: [channel.dmBotId], trigger: 'user' };
  const memberIds = await channelBotIds(ctx, channel.id);
  if (memberIds.length === 0) return { channel, botIds: [], trigger: 'user' };
  const members = await ctx.db.select({ id: bots.id, slug: bots.slug }).from(bots).where(inArray(bots.id, memberIds));
  const mentioned = extractMentions(message.content, members.map((m) => m.slug));
  if (mentioned.length > 0) return { channel, botIds: mentioned.map((slug) => members.find((m) => m.slug === slug)!.id), trigger: 'mention' };
  let botIds: string[] = [];
  if (message.threadRootId) {
    const participants = await ctx.db
      .selectDistinct({ botId: messages.botId })
      .from(messages)
      .where(and(eq(messages.authorKind, 'bot'), inArray(messages.id, [message.threadRootId])));
    const replies = await ctx.db
      .selectDistinct({ botId: messages.botId })
      .from(messages)
      .where(and(eq(messages.authorKind, 'bot'), eq(messages.threadRootId, message.threadRootId)));
    botIds = [...new Set([...participants, ...replies].map((p) => p.botId).filter((id): id is string => !!id && memberIds.includes(id)))];
  }
  return { channel, botIds: botIds.length > 0 ? botIds : [memberIds[0]!], trigger: 'user' };
}

/** Queues the runs of the bots that answer a message you posted (resolveMessageTargets). */
export async function dispatchUserMessage(ctx: Ctx, message: MessageDTO, overrides: RunOverrides = {}): Promise<RunDTO[]> {
  const { channel, botIds: targets, trigger } = await resolveMessageTargets(ctx, message);
  if (targets.length === 0) {
    await createMessage(ctx, {
      channelId: channel.id,
      threadRootId: message.threadRootId,
      authorKind: 'system',
      content: 'Ce canal ne contient aucun bot. Ajoute des bots dans les réglages du canal.',
      meta: { kind: 'info' },
    });
    return [];
  }

  const chainId = randomUUID();
  const created: RunDTO[] = [];
  for (const botId of targets) {
    const run = await requestRun(ctx, {
      botId,
      channelId: channel.id,
      threadRootId: message.threadRootId,
      trigger,
      priority: 'interactive',
      origin: 'user',
      chainId,
      prompt: message.content,
      model: overrides.model,
      effort: overrides.effort,
      payload: overrides.payload,
    });
    if (run) created.push(run);
    else {
      const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, botId) });
      await createMessage(ctx, {
        channelId: channel.id,
        threadRootId: message.threadRootId,
        authorKind: 'system',
        content: `${bot?.name ?? 'Ce bot'} est en pause : réactive-le dans sa fiche pour qu’il réponde.`,
        meta: { kind: 'info' },
      });
    }
  }
  return created;
}
