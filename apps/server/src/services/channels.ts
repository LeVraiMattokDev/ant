import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { ChannelDTO, ChannelInput } from '@ant/shared';
import { bots, channelMembers, channels } from '../db/schema';
import { channelToDTO } from '../lib/dto';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import type { Ctx } from './context';

export type ChannelRow = typeof channels.$inferSelect;

export async function getChannel(ctx: Ctx, id: string): Promise<ChannelRow> {
  const row = await ctx.db.query.channels.findFirst({ where: and(eq(channels.id, id), isNull(channels.archivedAt)) });
  if (!row) throw new HttpError(404, 'not_found', 'Canal introuvable.');
  return row;
}

export async function channelBotIds(ctx: Ctx, channelId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ botId: channelMembers.botId })
    .from(channelMembers)
    .innerJoin(bots, eq(bots.id, channelMembers.botId))
    .where(and(eq(channelMembers.channelId, channelId), isNull(bots.archivedAt)))
    .orderBy(asc(bots.createdAt));
  return rows.map((r) => r.botId);
}

export async function listChannels(ctx: Ctx): Promise<ChannelDTO[]> {
  const rows = await ctx.db.select().from(channels).where(isNull(channels.archivedAt)).orderBy(desc(channels.lastMessageAt));
  if (rows.length === 0) return [];
  const members = await ctx.db
    .select({ channelId: channelMembers.channelId, botId: channelMembers.botId })
    .from(channelMembers)
    .where(inArray(channelMembers.channelId, rows.map((r) => r.id)));
  return rows.map((r) => channelToDTO(r, members.filter((m) => m.channelId === r.id).map((m) => m.botId)));
}

async function assertBots(ctx: Ctx, botIds: string[]): Promise<void> {
  if (botIds.length === 0) return;
  const found = await ctx.db.select({ id: bots.id }).from(bots).where(and(inArray(bots.id, botIds), isNull(bots.archivedAt)));
  if (found.length !== new Set(botIds).size) throw new HttpError(400, 'unknown_bot', 'Un des bots indiqués est introuvable.');
}

export async function createGroupChannel(ctx: Ctx, input: ChannelInput): Promise<ChannelDTO> {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, 'invalid_name', 'Le nom du canal est obligatoire.');
  const botIds = [...new Set(input.botIds)];
  await assertBots(ctx, botIds);
  const channel = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.insert(channels).values({ kind: 'group', name, topic: input.topic ?? '' }).returning();
    if (!row) throw new Error('insert channel failed');
    if (botIds.length > 0) await tx.insert(channelMembers).values(botIds.map((botId) => ({ channelId: row.id, botId })));
    return row;
  });
  await publish(ctx.sql, { type: 'channel.updated', channelId: channel.id });
  return channelToDTO(channel, botIds);
}

export async function updateGroupChannel(ctx: Ctx, id: string, input: Partial<ChannelInput>): Promise<ChannelDTO> {
  const current = await getChannel(ctx, id);
  if (current.kind !== 'group') throw new HttpError(400, 'not_group', 'Seuls les canaux de groupe sont modifiables.');
  const botIds = input.botIds ? [...new Set(input.botIds)] : undefined;
  if (botIds) await assertBots(ctx, botIds);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(channels)
      .set({ name: input.name?.trim() || current.name, topic: input.topic ?? current.topic })
      .where(eq(channels.id, id));
    if (botIds) {
      await tx.delete(channelMembers).where(eq(channelMembers.channelId, id));
      if (botIds.length > 0) await tx.insert(channelMembers).values(botIds.map((botId) => ({ channelId: id, botId })));
    }
  });
  await publish(ctx.sql, { type: 'channel.updated', channelId: id });
  const updated = await getChannel(ctx, id);
  return channelToDTO(updated, await channelBotIds(ctx, id));
}

export async function archiveChannel(ctx: Ctx, id: string): Promise<void> {
  const current = await getChannel(ctx, id);
  if (current.kind !== 'group') throw new HttpError(400, 'not_group', 'Les messages privés ne peuvent pas être supprimés (archive le bot).');
  await ctx.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, id));
  await publish(ctx.sql, { type: 'channel.updated', channelId: id });
}
