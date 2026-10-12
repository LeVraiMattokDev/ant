import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  DEFAULT_BOT_EFFORT,
  DEFAULT_BOT_MODEL,
  DEFAULT_BOT_PERMISSIONS,
  SLUG_RE,
  isEffortLevel,
  slugify,
  type BotDTO,
  type BotInput,
} from '@ant/shared';
import { bots, channelMembers, channels, runs } from '../db/schema';
import { botToDTO } from '../lib/dto';
import { publish } from '../lib/events';
import { HttpError } from '../lib/errors';
import type { Ctx } from './context';

export type BotRow = typeof bots.$inferSelect;

async function uniqueSlug(ctx: Ctx, wanted: string, excludeId?: string): Promise<string> {
  const base = slugify(wanted) || 'bot';
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 36)}-${i}`;
    const existing = await ctx.db.query.bots.findFirst({ where: eq(bots.slug, candidate) });
    if (!existing || existing.id === excludeId) return candidate;
  }
  throw new HttpError(409, 'slug_taken', 'Impossible de trouver un identifiant libre pour ce bot.');
}

function validateInput(input: Partial<BotInput>): void {
  if (input.effort !== undefined && !isEffortLevel(input.effort)) throw new HttpError(400, 'invalid_effort', 'Niveau d’effort invalide.');
  if (input.slug !== undefined && !SLUG_RE.test(input.slug)) {
    throw new HttpError(400, 'invalid_slug', 'Identifiant invalide : lettres minuscules, chiffres et tirets.');
  }
  if (input.heartbeatIntervalMin !== undefined && (input.heartbeatIntervalMin < 15 || input.heartbeatIntervalMin > 7 * 24 * 60)) {
    throw new HttpError(400, 'invalid_heartbeat', 'La fréquence du heartbeat doit être comprise entre 15 minutes et 7 jours.');
  }
}

export async function createBot(ctx: Ctx, input: BotInput): Promise<BotDTO> {
  validateInput(input);
  const slug = await uniqueSlug(ctx, input.slug ?? input.name);
  return ctx.db.transaction(async (tx) => {
    const [bot] = await tx
      .insert(bots)
      .values({
        slug,
        name: input.name.trim(),
        avatar: input.avatar?.trim() || '🐜',
        role: input.role.trim(),
        instructions: input.instructions ?? '',
        model: input.model ?? DEFAULT_BOT_MODEL,
        effort: input.effort ?? DEFAULT_BOT_EFFORT,
        permissions: { ...DEFAULT_BOT_PERMISSIONS, ...input.permissions },
        heartbeatEnabled: input.heartbeatEnabled ?? true,
        heartbeatIntervalMin: input.heartbeatIntervalMin ?? 180,
        quietHours: input.quietHours ?? null,
        apiDailyCapUsd: input.apiDailyCapUsd ?? null,
        paused: input.paused ?? false,
      })
      .returning();
    if (!bot) throw new Error('insert bot failed');
    const [dm] = await tx.insert(channels).values({ kind: 'dm', name: bot.name, dmBotId: bot.id }).returning();
    if (!dm) throw new Error('insert dm failed');
    await tx.insert(channelMembers).values({ channelId: dm.id, botId: bot.id });
    return botToDTO(bot, dm.id);
  });
}

export async function updateBot(ctx: Ctx, id: string, input: Partial<BotInput>): Promise<BotDTO> {
  validateInput(input);
  const current = await getBot(ctx, id);
  const slug = input.slug && input.slug !== current.slug ? await uniqueSlug(ctx, input.slug, id) : current.slug;
  const [row] = await ctx.db
    .update(bots)
    .set({
      slug,
      name: input.name?.trim() ?? current.name,
      avatar: input.avatar?.trim() ?? current.avatar,
      role: input.role?.trim() ?? current.role,
      instructions: input.instructions ?? current.instructions,
      model: input.model ?? current.model,
      effort: input.effort ?? current.effort,
      permissions: { ...DEFAULT_BOT_PERMISSIONS, ...current.permissions, ...input.permissions },
      heartbeatEnabled: input.heartbeatEnabled ?? current.heartbeatEnabled,
      heartbeatIntervalMin: input.heartbeatIntervalMin ?? current.heartbeatIntervalMin,
      quietHours: input.quietHours === undefined ? current.quietHours : input.quietHours,
      apiDailyCapUsd: input.apiDailyCapUsd === undefined ? current.apiDailyCapUsd : input.apiDailyCapUsd,
      paused: input.paused ?? current.paused,
      updatedAt: new Date(),
    })
    .where(eq(bots.id, id))
    .returning();
  if (!row) throw new HttpError(404, 'not_found', 'Bot introuvable.');
  if (input.name && input.name !== current.name) {
    await ctx.db.update(channels).set({ name: row.name }).where(and(eq(channels.dmBotId, id), eq(channels.kind, 'dm')));
  }
  await publish(ctx.sql, { type: 'bot.updated', botId: id });
  return (await listBots(ctx)).find((b) => b.id === id) ?? botToDTO(row, '');
}

export async function archiveBot(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.update(bots).set({ archivedAt: new Date(), paused: true, updatedAt: new Date() }).where(eq(bots.id, id));
  await ctx.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.dmBotId, id));
  await publish(ctx.sql, { type: 'bot.updated', botId: id });
}

export async function getBot(ctx: Ctx, id: string): Promise<BotRow> {
  const row = await ctx.db.query.bots.findFirst({ where: and(eq(bots.id, id), isNull(bots.archivedAt)) });
  if (!row) throw new HttpError(404, 'not_found', 'Bot introuvable.');
  return row;
}

export async function findBotBySlug(ctx: Ctx, slug: string): Promise<BotRow | undefined> {
  return ctx.db.query.bots.findFirst({ where: and(eq(bots.slug, slug.toLowerCase()), isNull(bots.archivedAt)) });
}

export async function activeBots(ctx: Ctx): Promise<BotRow[]> {
  return ctx.db.select().from(bots).where(isNull(bots.archivedAt)).orderBy(asc(bots.createdAt));
}

export async function dmChannelId(ctx: Ctx, botId: string): Promise<string> {
  const ch = await ctx.db.query.channels.findFirst({ where: and(eq(channels.dmBotId, botId), eq(channels.kind, 'dm')) });
  if (!ch) throw new Error(`DM channel missing for bot ${botId}`);
  return ch.id;
}

export async function listBots(ctx: Ctx): Promise<BotDTO[]> {
  const rows = await activeBots(ctx);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const dms = await ctx.db
    .select({ id: channels.id, botId: channels.dmBotId })
    .from(channels)
    .where(and(eq(channels.kind, 'dm'), inArray(channels.dmBotId, ids)));
  const active = await ctx.db
    .select({ botId: runs.botId, activity: runs.activity })
    .from(runs)
    .where(and(inArray(runs.botId, ids), eq(runs.status, 'running')));
  return rows.map((r) =>
    botToDTO(
      r,
      dms.find((d) => d.botId === r.id)?.id ?? '',
      active.find((a) => a.botId === r.id)?.activity ?? (active.some((a) => a.botId === r.id) ? 'au travail' : null),
    ),
  );
}
