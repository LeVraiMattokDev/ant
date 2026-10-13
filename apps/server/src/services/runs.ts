import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, sql as dsql } from 'drizzle-orm';
import { extractMentions, type MessageDTO, type RunDTO, type RunOrigin, type RunPriority, type RunTrigger } from '@ant/shared';
import { bots, jobs, messages, runs, type RunPayload } from '../db/schema';
import { audit } from '../lib/audit';
import { runToDTO } from '../lib/dto';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import { enqueue } from '../lib/jobs';
import { channelBotIds, getChannel } from './channels';
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
      model: bot.model,
      effort: bot.effort,
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

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'error']);

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

/** The bot.run job failed for good (uncaught error on its last attempt): record the failure on the run. */
export async function failRun(ctx: Ctx, runId: string, reason: string): Promise<void> {
  const run = await getRun(ctx, runId);
  if (!run || TERMINAL_STATUSES.has(run.status)) return;
  const short = reason.split('\n')[0]!.slice(0, 300);
  await closeStrandedRun(ctx, run, 'error', `Erreur interne : ${reason.slice(0, 2000)}`, `⚠️ Erreur interne : ${short}`);
}

/**
 * Runs left queued, running or paused without any pending or running job (job failed, purged, or the
 * worker died between two writes) would stay active forever: close them. `graceMs` covers the gap
 * between inserting a run and enqueuing its job.
 */
export async function sweepOrphanRuns(ctx: Ctx, now = new Date(), graceMs = 2 * 60_000): Promise<number> {
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
  }
  return orphans.length;
}

export async function cancelRun(ctx: Ctx, id: string): Promise<void> {
  const run = await getRun(ctx, id);
  if (!run) throw new HttpError(404, 'not_found', 'Exécution introuvable.');
  if (run.status === 'queued' || run.status === 'paused') {
    await updateRun(ctx, id, { status: 'cancelled', finishedAt: new Date(), activity: null });
  } else if (run.status === 'running' && !(await runJobIsRunning(ctx, id))) {
    // No live AbortController for it (job waiting for a retry, or failed for good): the NOTIFY alone would do nothing.
    await closeStrandedRun(ctx, run, 'cancelled', 'Exécution annulée.', '⚠️ Exécution annulée.');
  }
  await ctx.sql.notify(CONTROL_CHANNEL, JSON.stringify({ type: 'cancel', runId: id }));
}

/**
 * Decides which bots answer a message you posted, then queues their runs.
 * - DM: the bot of the DM.
 * - Group: the @mentioned members; otherwise the bots already in the thread; otherwise the first member.
 */
export async function dispatchUserMessage(ctx: Ctx, message: MessageDTO): Promise<RunDTO[]> {
  const channel = await getChannel(ctx, message.channelId);
  let targets: string[] = [];
  let trigger: RunTrigger = 'user';
  if (channel.kind === 'dm' && channel.dmBotId) {
    targets = [channel.dmBotId];
  } else {
    const memberIds = await channelBotIds(ctx, channel.id);
    if (memberIds.length === 0) {
      await createMessage(ctx, {
        channelId: channel.id,
        threadRootId: message.threadRootId,
        authorKind: 'system',
        content: 'Ce canal ne contient aucun bot. Ajoute des bots dans les réglages du canal.',
        meta: { kind: 'info' },
      });
      return [];
    }
    const members = await ctx.db.select({ id: bots.id, slug: bots.slug }).from(bots).where(inArray(bots.id, memberIds));
    const mentioned = extractMentions(message.content, members.map((m) => m.slug));
    if (mentioned.length > 0) {
      targets = mentioned.map((slug) => members.find((m) => m.slug === slug)!.id);
      trigger = 'mention';
    } else if (message.threadRootId) {
      const participants = await ctx.db
        .selectDistinct({ botId: messages.botId })
        .from(messages)
        .where(and(eq(messages.authorKind, 'bot'), inArray(messages.id, [message.threadRootId])));
      const replies = await ctx.db
        .selectDistinct({ botId: messages.botId })
        .from(messages)
        .where(and(eq(messages.authorKind, 'bot'), eq(messages.threadRootId, message.threadRootId)));
      targets = [...new Set([...participants, ...replies].map((p) => p.botId).filter((id): id is string => !!id && memberIds.includes(id)))];
    }
    if (targets.length === 0) targets = [memberIds[0]!];
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
