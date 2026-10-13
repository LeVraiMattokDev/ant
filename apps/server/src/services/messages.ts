import { and, asc, desc, eq, isNull, lt, notInArray, sql as dsql, type SQL } from 'drizzle-orm';
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

/**
 * Top-level messages of a channel, newest last, with reply counts.
 * Paging: `beforeId` (the oldest message already shown) is a keyset cursor on (created_at, id), compared at full
 * precision in SQL; a millisecond ISO `before` would skip messages written within the same millisecond.
 */
export async function listChannelMessages(
  ctx: Ctx,
  channelId: string,
  opts: { before?: Date; beforeId?: string; limit?: number } = {},
): Promise<MessageDTO[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conditions = [eq(messages.channelId, channelId), isNull(messages.threadRootId)];
  if (opts.beforeId) {
    // Explicitly qualified: an interpolated column would bind to the inner alias. An unknown id gives an empty page.
    conditions.push(dsql`("messages"."created_at", "messages"."id") < (select c.created_at, c.id from messages c where c.id = ${opts.beforeId})`);
  } else if (opts.before) {
    conditions.push(lt(messages.createdAt, opts.before));
  }
  const rows = await ctx.db
    .select({
      m: messages,
      // Explicitly qualified: an interpolated column renders unqualified here and would bind to the inner alias.
      replyCount: dsql<number>`(select count(*)::int from messages r where r.thread_root_id = "messages"."id")`,
      lastReplyAt: dsql<string | null>`(select max(r.created_at) from messages r where r.thread_root_id = "messages"."id")`,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
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
  /**
   * 'all' (the search page): every term is required. 'broad' (default, the bots' search_messages tool): when fewer
   * than `limit` messages contain every term, messages containing any of them complete the list, ranked after.
   */
  match?: 'all' | 'broad';
  /** Delimiters around matched words in the snippet. Default '**' (markdown bold, readable by the bots). */
  marks?: { start: string; end: string };
}

/** Sentinels for ts_headline: control characters never found in the text (unlike « », which French uses). */
const HL_START = '\u0002';
const HL_END = '\u0003';
const HEADLINE_OPTS = `StartSel=${HL_START}, StopSel=${HL_END}, MaxWords=30, MinWords=10`;
/**
 * Characters ts_headline must not interpret, each replaced by NEUTRAL (one for one, so offsets are kept): '<' starts
 * what its parser takes for an XML tag (`Promise<void>`, `<div>`, « » unaccented to << >>), which the excerpt drops;
 * the sentinels, found in a message, would fake highlights.
 */
const NEUTRAL = '\u0001';
const NEUTRALIZED = `<${HL_START}${HL_END}`;
const NEUTRALIZED_RE = /[<\u0002\u0003]/g;

/** Positive and excluded terms of a websearch-style query ("exact phrase", -exclusion, or). */
export function splitWebsearch(query: string): { positive: string; negative: string } {
  const positive: string[] = [];
  const negative: string[] = [];
  for (const m of query.matchAll(/(^|\s)(-?)(?:"([^"]*)"?|(\S+))/g)) {
    const text = (m[3] ?? m[4] ?? '').trim();
    if (!text) continue;
    if (m[2] === '-') negative.push(text);
    else if (!/^or$/i.test(text)) positive.push(text);
  }
  return { positive: positive.join(' '), negative: negative.join(' ') };
}

/** OR of the French lexemes of `text`, as a tsquery (empty when it has no lexeme). Lexemes are quoted for tsquery input. */
function anyLexeme(text: string): SQL {
  // Backslashes and quotes doubled (SQL source below: '\' and '\\', standard_conforming_strings).
  return dsql`(select coalesce(string_agg(x.q, ' | '), '')::tsquery
    from (select '''' || replace(replace(l, '\\', '\\\\'), '''', '''''') || '''' as q
          from unnest(tsvector_to_array(to_tsvector('french', ant_unaccent(${text})))) as l) as x)`;
}

/** Every term required (websearch syntax), accents ignored. */
export function allTermsQuery(query: string): SQL {
  return dsql`websearch_to_tsquery('french', ant_unaccent(${query}))`;
}

/**
 * Any of the terms (each word's lexeme OR-ed), exclusions kept: finds « Projet Kozmo : lancement prévu en
 * janvier 2027 » for « Kozmo date de sortie ». Null when the query has no positive term.
 */
export function anyTermQuery(query: string): SQL | null {
  const { positive, negative } = splitWebsearch(query);
  if (!positive) return null;
  return negative ? dsql`(${anyLexeme(positive)} && !!${anyLexeme(negative)})` : anyLexeme(positive);
}

// ── Snippets: ts_headline runs on the unaccented text (so « reunion » highlights « Réunion »), then the excerpt
// and its highlights are mapped back onto the original text, so accents, apostrophes and tag-like text are kept.

const unaccented = new Map<string, string>();

async function loadUnaccent(ctx: Ctx, texts: string[]): Promise<void> {
  const missing = new Set<string>();
  for (const t of texts) for (const ch of t) if (ch.charCodeAt(0) > 127 && !unaccented.has(ch)) missing.add(ch);
  if (missing.size === 0) return;
  if (unaccented.size > 20_000) unaccented.clear();
  const rows = await ctx.sql<{ c: string; u: string }[]>`select c, ant_unaccent(c) as u from unnest(${ctx.sql.array([...missing])}::text[]) as c`;
  for (const r of rows) unaccented.set(r.c, r.u);
}

/**
 * Removes emphasis markers left unpaired because the excerpt cut their span (the UI's stripMarkdown only drops pairs).
 * Runs before the highlight marks are inserted: the bots' default marks are '**' too.
 */
function dropUnpairedEmphasis(snippet: string, before: string, after: string): string {
  let out = snippet;
  for (const marker of ['**', '__', '~~']) {
    const count = (t: string) => t.split(marker).length - 1;
    if (count(before) % 2 === 1) {
      const i = out.indexOf(marker);
      if (i >= 0) out = out.slice(0, i) + out.slice(i + marker.length);
    }
    if (count(after) % 2 === 1) {
      const i = out.lastIndexOf(marker);
      if (i >= 0) out = out.slice(0, i) + out.slice(i + marker.length);
    }
  }
  return out;
}

/** Maps a headline computed on the neutralized ant_unaccent(content) back onto `content`, with `marks` around the matches. */
function buildSnippet(content: string, headline: string, marks: { start: string; end: string }): string {
  const withMarks = (text: string) => text.split(HL_START).join(marks.start).split(HL_END).join(marks.end);
  // Unaccented, neutralized copy (as given to ts_headline), remembering which original character produced each of its characters.
  let u = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of content) {
    const rep = (ch.charCodeAt(0) > 127 ? (unaccented.get(ch) ?? ch) : ch).replace(NEUTRALIZED_RE, NEUTRAL);
    for (let k = 0; k < rep.length; k++) {
      from.push(i);
      to.push(i + ch.length);
    }
    u += rep;
    i += ch.length;
  }
  let plain = '';
  const ranges: [number, number][] = [];
  let open = -1;
  for (const ch of headline) {
    if (ch === HL_START) open = plain.length;
    else if (ch === HL_END) {
      if (open >= 0 && plain.length > open) ranges.push([open, plain.length]);
      open = -1;
    } else plain += ch;
  }
  const at = plain ? u.indexOf(plain) : -1;
  if (at < 0) {
    // Not found (an unusual unaccent rule): keep the unaccented excerpt rather than lose the highlights.
    return withMarks(headline.split(NEUTRAL).join('<'));
  }
  const startOf = (k: number) => (k < from.length ? from[k]! : content.length);
  const endOf = (k: number) => (k <= 0 ? 0 : to[k - 1]!);
  // Sentinels found in the message itself must not read as highlights once replaced by the marks.
  const slice = (a: number, b: number) => content.slice(a, b).replace(/[\u0002\u0003]/g, ' ');
  const s = startOf(at);
  const e = endOf(at + plain.length);
  let out = '';
  let cursor = s;
  for (const [a, b] of ranges) {
    const ra = startOf(at + a);
    const rb = endOf(at + b);
    if (ra < cursor || rb <= ra) continue;
    out += slice(cursor, ra) + HL_START + slice(ra, rb) + HL_END;
    cursor = rb;
  }
  out += slice(cursor, e);
  return withMarks(dropUnpairedEmphasis(out, content.slice(0, s), content.slice(e)));
}

export async function searchMessages(ctx: Ctx, q: string, filters: SearchFilters = {}): Promise<SearchResultDTO[]> {
  const query = q.trim();
  if (!query) return [];
  const limit = Math.min(Math.max(filters.limit ?? 30, 1), 100);
  const marks = filters.marks ?? { start: '**', end: '**' };
  const scope: SQL[] = [];
  if (filters.channelId) scope.push(eq(messages.channelId, filters.channelId));
  if (filters.botId) scope.push(eq(messages.botId, filters.botId));
  if (filters.from) scope.push(dsql`${messages.createdAt} >= ${filters.from}`);
  if (filters.to) scope.push(dsql`${messages.createdAt} <= ${filters.to}`);

  const find = (tsq: SQL, extra: SQL[], max: number) =>
    ctx.db
      .select({
        m: messages,
        channelName: channels.name,
        headline: dsql<string>`ts_headline('french', translate(ant_unaccent(${messages.content}), ${NEUTRALIZED}, ${NEUTRAL.repeat(NEUTRALIZED.length)}), ${tsq}, ${HEADLINE_OPTS})`,
      })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(and(dsql`${messages.searchVector} @@ ${tsq}`, ...scope, ...extra))
      .orderBy(dsql`ts_rank_cd(${messages.searchVector}, ${tsq}) desc`, desc(messages.createdAt))
      .limit(max);

  const rows = await find(allTermsQuery(query), [], limit);
  if ((filters.match ?? 'broad') === 'broad' && rows.length < limit) {
    const any = anyTermQuery(query);
    if (any) {
      const seen = rows.map((r) => r.m.id);
      rows.push(...(await find(any, seen.length ? [notInArray(messages.id, seen)] : [], limit - rows.length)));
    }
  }
  await loadUnaccent(ctx, rows.map((r) => r.m.content));
  return rows.map((r) => ({ message: messageToDTO(r.m), channelName: r.channelName, snippet: buildSnippet(r.m.content, r.headline, marks) }));
}
