import { and, desc, eq, or, sql as dsql } from 'drizzle-orm';
import { MEMORY_KINDS, type MemoryInput, type MemoryItemDTO, type MemoryKind, type MemoryScope } from '@ant/shared';
import { memoryItems } from '../db/schema';
import { memoryToDTO } from '../lib/dto';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import type { Ctx } from './context';

export interface MemoryAuthor {
  kind: 'user' | 'bot';
  botId?: string | null;
}

function validate(input: Partial<MemoryInput>): void {
  if (input.kind !== undefined && !(MEMORY_KINDS as readonly string[]).includes(input.kind)) {
    throw new HttpError(400, 'invalid_kind', 'Type de mémoire invalide.');
  }
  if (input.title !== undefined && (input.title.trim().length === 0 || input.title.length > 200)) {
    throw new HttpError(400, 'invalid_title', 'Titre obligatoire (200 caractères max).');
  }
  if (input.content !== undefined && input.content.length > 20_000) throw new HttpError(400, 'too_long', 'Contenu trop long (20 000 caractères max).');
  if (input.importance !== undefined && (input.importance < 1 || input.importance > 5)) {
    throw new HttpError(400, 'invalid_importance', 'Importance entre 1 et 5.');
  }
}

export interface MemoryFilter {
  scope?: MemoryScope;
  botId?: string;
  q?: string;
  pinned?: boolean;
  kind?: MemoryKind;
  limit?: number;
}

export async function listMemory(ctx: Ctx, filter: MemoryFilter = {}): Promise<MemoryItemDTO[]> {
  const conditions = [];
  if (filter.scope) conditions.push(eq(memoryItems.scope, filter.scope));
  if (filter.botId) conditions.push(eq(memoryItems.botId, filter.botId));
  if (filter.pinned !== undefined) conditions.push(eq(memoryItems.pinned, filter.pinned));
  if (filter.kind) conditions.push(eq(memoryItems.kind, filter.kind));
  if (filter.q?.trim()) {
    conditions.push(dsql`${memoryItems.searchVector} @@ websearch_to_tsquery('french', ant_unaccent(${filter.q.trim()}))`);
  }
  const rows = await ctx.db
    .select()
    .from(memoryItems)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(memoryItems.pinned), desc(memoryItems.importance), desc(memoryItems.updatedAt))
    .limit(Math.min(filter.limit ?? 500, 1000));
  return rows.map(memoryToDTO);
}

export async function getMemory(ctx: Ctx, id: string) {
  const row = await ctx.db.query.memoryItems.findFirst({ where: eq(memoryItems.id, id) });
  if (!row) throw new HttpError(404, 'not_found', 'Élément de mémoire introuvable.');
  return row;
}

export async function createMemory(ctx: Ctx, input: MemoryInput, author: MemoryAuthor, sourceMessageId?: string | null): Promise<MemoryItemDTO> {
  validate(input);
  if (input.scope === 'bot' && !input.botId) throw new HttpError(400, 'missing_bot', 'Une mémoire de bot doit indiquer le bot.');
  const [row] = await ctx.db
    .insert(memoryItems)
    .values({
      scope: input.scope,
      botId: input.scope === 'bot' ? (input.botId ?? null) : null,
      kind: input.kind,
      title: input.title.trim(),
      content: input.content,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 20),
      pinned: input.pinned ?? false,
      importance: input.importance ?? 3,
      authorKind: author.kind,
      authorBotId: author.botId ?? null,
      sourceMessageId: sourceMessageId ?? null,
    })
    .returning();
  await publish(ctx.sql, { type: 'memory.updated' });
  return memoryToDTO(row!);
}

export async function updateMemory(ctx: Ctx, id: string, input: Partial<MemoryInput>): Promise<MemoryItemDTO> {
  validate(input);
  const current = await getMemory(ctx, id);
  const scope = input.scope ?? current.scope;
  const botId = scope === 'bot' ? (input.botId ?? current.botId) : null;
  if (scope === 'bot' && !botId) throw new HttpError(400, 'missing_bot', 'Une mémoire de bot doit indiquer le bot.');
  const [row] = await ctx.db
    .update(memoryItems)
    .set({
      scope,
      botId,
      kind: input.kind ?? current.kind,
      title: input.title?.trim() ?? current.title,
      content: input.content ?? current.content,
      tags: input.tags ? input.tags.map((t) => t.trim()).filter(Boolean).slice(0, 20) : current.tags,
      pinned: input.pinned ?? current.pinned,
      importance: input.importance ?? current.importance,
      updatedAt: new Date(),
    })
    .where(eq(memoryItems.id, id))
    .returning();
  await publish(ctx.sql, { type: 'memory.updated' });
  return memoryToDTO(row!);
}

export async function deleteMemory(ctx: Ctx, id: string): Promise<void> {
  await getMemory(ctx, id);
  await ctx.db.delete(memoryItems).where(eq(memoryItems.id, id));
  await publish(ctx.sql, { type: 'memory.updated' });
}

/** Memory visible to a bot: shared items + its own. */
function visibleTo(botId: string) {
  return or(eq(memoryItems.scope, 'shared'), and(eq(memoryItems.scope, 'bot'), eq(memoryItems.botId, botId)));
}

export async function searchMemoryForBot(ctx: Ctx, botId: string, query: string, limit = 10): Promise<MemoryItemDTO[]> {
  const q = query.trim();
  const rows = await ctx.db
    .select()
    .from(memoryItems)
    .where(q ? and(visibleTo(botId), dsql`${memoryItems.searchVector} @@ websearch_to_tsquery('french', ant_unaccent(${q}))`) : visibleTo(botId))
    .orderBy(
      q ? dsql`ts_rank(${memoryItems.searchVector}, websearch_to_tsquery('french', ant_unaccent(${q}))) desc` : desc(memoryItems.updatedAt),
      desc(memoryItems.importance),
    )
    .limit(Math.min(limit, 30));
  return rows.map(memoryToDTO);
}

/** Pinned memory injected in the stable part of a bot's system prompt (bounded size). */
export async function pinnedMemoryBlock(ctx: Ctx, botId: string, maxChars = 8000): Promise<string> {
  const rows = await ctx.db
    .select()
    .from(memoryItems)
    .where(and(visibleTo(botId), eq(memoryItems.pinned, true)))
    .orderBy(memoryItems.scope, desc(memoryItems.importance), memoryItems.createdAt);
  const lines: string[] = [];
  let size = 0;
  for (const r of rows) {
    const line = `- [${r.scope === 'shared' ? 'partagé' : 'perso'} · ${r.kind}] ${r.title} : ${r.content.replace(/\s+/g, ' ').trim()} (id ${r.id})`;
    if (size + line.length > maxChars) {
      lines.push('- … (autres éléments épinglés : utilise memory_search)');
      break;
    }
    lines.push(line);
    size += line.length;
  }
  return lines.join('\n');
}

export async function botCanEditMemory(ctx: Ctx, botId: string, id: string, sharedWrite: boolean) {
  const row = await getMemory(ctx, id);
  if (row.scope === 'shared' && !sharedWrite) throw new HttpError(403, 'forbidden', 'Ce bot n’a pas le droit de modifier la mémoire partagée.');
  if (row.scope === 'bot' && row.botId !== botId) throw new HttpError(403, 'forbidden', 'Cette mémoire appartient à un autre bot.');
  return row;
}

