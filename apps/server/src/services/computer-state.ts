import { eq } from 'drizzle-orm';
import type { ComputerHolder, ComputerStatusDTO } from '@ant/shared';
import { computerState } from '../db/schema';
import { publish } from '../lib/events';
import type { Ctx } from './context';

export async function getComputerState(ctx: Ctx) {
  const row = await ctx.db.query.computerState.findFirst({ where: eq(computerState.id, 1) });
  if (row) return row;
  await ctx.db.insert(computerState).values({ id: 1 }).onConflictDoNothing();
  return (await ctx.db.query.computerState.findFirst({ where: eq(computerState.id, 1) }))!;
}

export async function computerStatus(ctx: Ctx, online: boolean): Promise<ComputerStatusDTO> {
  const s = await getComputerState(ctx);
  return {
    online,
    holder: s.holder,
    since: s.since.toISOString(),
    activeBotId: s.activeBotId ?? null,
    lastAction: s.lastAction ?? null,
    url: s.url ?? null,
  };
}

export async function setComputerHolder(ctx: Ctx, holder: ComputerHolder): Promise<void> {
  await getComputerState(ctx);
  await ctx.db.update(computerState).set({ holder, since: new Date(), updatedAt: new Date() }).where(eq(computerState.id, 1));
  await publish(ctx.sql, { type: 'computer.updated', status: await computerStatus(ctx, true) });
}

export async function recordComputerAction(ctx: Ctx, botId: string, action: string, url?: string | null): Promise<void> {
  await getComputerState(ctx);
  await ctx.db
    .update(computerState)
    .set({ activeBotId: botId, lastAction: action.slice(0, 500), ...(url !== undefined ? { url } : {}), updatedAt: new Date() })
    .where(eq(computerState.id, 1));
  await publish(ctx.sql, { type: 'computer.updated', status: await computerStatus(ctx, true) });
}
