import { and, asc, desc, eq, isNull, lt, sql as dsql } from 'drizzle-orm';
import type { AuthorKind, MessageDTO, MessageMeta, MessageStatus, SearchResultDTO } from '@ant/shared';
import { channels, messages } from '../db/schema';
import { messageToDTO } from '../lib/dto';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import type { Ctx } from './context';

export type MessageRow = typeof messages.$inferSelect;

export interface NewMessage {
  channelId: string;
  threadRootId?: string | null;
  authorKind: AuthorKind;
  botId?: string | null;
  content: string;
  meta?: MessageMeta;
  status?: MessageStatus;
  runId?: string | null;
}

export async function createMessage(ctx: Ctx, input: NewMessage): Promise<MessageDTO> {
  if (input.threadRootId) {
    const root = await ctx.db.query.messages.findFirst({ where: eq(messages.id, input.threadRootId) });
    if (!root || root.channelId !== input.channelId) throw new HttpError(400, 'invalid_thread', 'Fil introuvable dans ce canal.');
    if (root.threadRootId) throw new HttpError(400, 'nested_thread', 'Un fil ne peut pas contenir de sous-fil.');
  }
  const [row] = await ctx.db
    .insert(messages)
    .values({
      channelId: input.channelId,
      threadRootId: input.threadRootId ?? null,
      authorKind: input.authorKind,
      botId: input.botId ?? null,
      content: input.content,
      meta: input.meta ?? {},
      status: input.status ?? 'done',
      runId: input.runId ?? null,
    })
    .returning();
  if (!row) throw new Error('insert message failed');
  await ctx.db.update(channels).set({ lastMessageAt: row.createdAt }).where(eq(channels.id, input.channelId));
  const dto = messageToDTO(row);
  await publish(ctx.sql, { type: 'message.created', message: dto });
  if (row.threadRootId) {
    const root = await getMessageDTO(ctx, row.threadRootId);
    if (root) await publish(ctx.sql, { type: 'message.updated', message: root });
  }
  return dto;
}

export async function updateMessage(
  ctx: Ctx,
  id: string,
  patch: { content?: string; meta?: MessageMeta; status?: MessageStatus },
): Promise<MessageDTO | null> {
  const current = await ctx.db.query.messages.findFirst({ where: eq(messages.id, id) });
  if (!current) return null;
  const [row] = await ctx.db
    .update(messages)
    .set({
      content: patch.content ?? current.content,
      meta: patch.meta ? { ...current.meta, ...patch.meta } : current.meta,
      status: patch.status ?? current.status,
      updatedAt: new Date(),
    })
    .where(eq(messages.id, id))
    .returning();
  if (!row) return null;
  const dto = await getMessageDTO(ctx, row.id);
  if (dto) await publish(ctx.sql, { type: 'message.updated', message: dto });
  return dto;
}

export async function getMessage(ctx: Ctx, id: string): Promise<MessageRow | undefined> {
  return ctx.db.query.messages.findFirst({ where: eq(messages.id, id) });
}

export async function getMessageDTO(ctx: Ctx, id: string): Promise<MessageDTO | null> {
  const row = await getMessage(ctx, id);
  if (!row) return null;
  const [stats] = await ctx.db
    .select({ count: dsql<number>`count(*)::int`, last: dsql<Date | null>`max(${messages.createdAt})` })
    .from(messages)
    .where(eq(messages.threadRootId, id));
  return messageToDTO(row, stats?.count ?? 0, stats?.last ? new Date(stats.last) : null);
}

/** Top-level messages of a channel, newest last, with reply counts. */
export async function listChannelMessages(ctx: Ctx, channelId: string, opts: { before?: Date; limit?: number } = {}): Promise<MessageDTO[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conditions = [eq(messages.channelId, channelId), isNull(messages.threadRootId)];
  if (opts.before) conditions.push(lt(messages.createdAt, opts.before));
  const rows = await ctx.db
    .select({
      m: messages,
      // Explicitly qualified: an interpolated column renders unqualified here and would bind to the inner alias.
      replyCount: dsql<number>`(select count(*)::int from messages r where r.thread_root_id = "messages"."id")`,
      lastReplyAt: dsql<string | null>`(select max(r.created_at) from messages r where r.thread_root_id = "messages"."id")`,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse().map((r) => messageToDTO(r.m, r.replyCount, r.lastReplyAt ? new Date(r.lastReplyAt) : null));
}

export async function getThread(ctx: Ctx, rootId: string): Promise<{ root: MessageDTO; replies: MessageDTO[] }> {
  const root = await getMessageDTO(ctx, rootId);
  if (!root) throw new HttpError(404, 'not_found', 'Message introuvable.');
  const rows = await ctx.db.select().from(messages).where(eq(messages.threadRootId, rootId)).orderBy(asc(messages.createdAt));
  return { root, replies: rows.map((r) => messageToDTO(r)) };
}

/** Recent conversation in a thread (or channel top level) as plain text for prompts. */
export async function recentTranscript(
  ctx: Ctx,
  channelId: string,
  threadRootId: string | null,
  limit: number,
  names: Map<string, string>,
): Promise<string> {
  const where = threadRootId
    ? dsql`(${messages.id} = ${threadRootId} or ${messages.threadRootId} = ${threadRootId})`
    : and(eq(messages.channelId, channelId), isNull(messages.threadRootId));
  const rows = await ctx.db.select().from(messages).where(where).orderBy(desc(messages.createdAt)).limit(limit);
  return rows
    .reverse()
    .filter((r) => r.status !== 'streaming')
    .map((r) => {
      const who = r.authorKind === 'user' ? 'Toi (propriétaire)' : r.authorKind === 'system' ? 'Système' : `@${names.get(r.botId ?? '') ?? 'bot'}`;
      return `[${r.createdAt.toISOString()}] ${who} : ${r.content}`;
    })
    .join('\n');
}

export interface SearchFilters {
  channelId?: string;
  botId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function searchMessages(ctx: Ctx, q: string, filters: SearchFilters = {}): Promise<SearchResultDTO[]> {
  const query = q.trim();
  if (!query) return [];
  const limit = Math.min(filters.limit ?? 30, 100);
  const tsq = dsql`websearch_to_tsquery('french', ant_unaccent(${query}))`;
  const conditions = [dsql`${messages.searchVector} @@ ${tsq}`];
  if (filters.channelId) conditions.push(eq(messages.channelId, filters.channelId));
  if (filters.botId) conditions.push(eq(messages.botId, filters.botId));
  if (filters.from) conditions.push(dsql`${messages.createdAt} >= ${filters.from}`);
  if (filters.to) conditions.push(dsql`${messages.createdAt} <= ${filters.to}`);
  const rows = await ctx.db
    .select({
      m: messages,
      channelName: channels.name,
      snippet: dsql<string>`ts_headline('french', ${messages.content}, ${tsq}, 'StartSel=«, StopSel=», MaxWords=30, MinWords=10')`,
      rank: dsql<number>`ts_rank(${messages.searchVector}, ${tsq})`,
    })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(and(...conditions))
    .orderBy(dsql`ts_rank(${messages.searchVector}, ${tsq}) desc`, desc(messages.createdAt))
    .limit(limit);
  return rows.map((r) => ({ message: messageToDTO(r.m), channelName: r.channelName, snippet: r.snippet }));
}
