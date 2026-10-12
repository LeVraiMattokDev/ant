import { and, desc, eq, gt } from 'drizzle-orm';
import type { NudgeDTO, NudgeKind, NudgeStatus } from '@ant/shared';
import { nudges } from '../db/schema';
import { fingerprint } from '../lib/crypto';
import { nudgeToDTO } from '../lib/dto';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import type { Ctx } from './context';

export async function listNudges(ctx: Ctx, filter: { botId?: string; limit?: number } = {}): Promise<NudgeDTO[]> {
  const rows = await ctx.db
    .select()
    .from(nudges)
    .where(filter.botId ? eq(nudges.botId, filter.botId) : undefined)
    .orderBy(desc(nudges.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200));
  return rows.map(nudgeToDTO);
}

export async function setNudgeStatus(ctx: Ctx, id: string, status: NudgeStatus): Promise<NudgeDTO> {
  const [row] = await ctx.db.update(nudges).set({ status }).where(eq(nudges.id, id)).returning();
  if (!row) throw new HttpError(404, 'not_found', 'Relance introuvable.');
  return nudgeToDTO(row);
}

/** Previous nudges of a bot, for the heartbeat prompt (so it does not repeat itself). */
export async function recentNudgesSummary(ctx: Ctx, botId: string, days: number): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await ctx.db
    .select()
    .from(nudges)
    .where(and(eq(nudges.botId, botId), gt(nudges.createdAt, since)))
    .orderBy(desc(nudges.createdAt))
    .limit(30);
  if (rows.length === 0) return '(aucune relance récente)';
  const label: Record<NudgeStatus, string> = { delivered: 'envoyée', deferred: 'reportée', dismissed: 'ignorée', acted: 'jugée utile' };
  return rows.map((r) => `- ${r.createdAt.toISOString().slice(0, 10)} [${r.kind}, ${label[r.status]}] ${r.title}`).join('\n');
}

export type DuplicateCheck = { duplicate: false; fingerprint: string } | { duplicate: true; fingerprint: string; previousAt: Date };

export async function checkDuplicate(ctx: Ctx, botId: string, title: string, content: string, cooldownDays: number): Promise<DuplicateCheck> {
  const fp = fingerprint(title);
  const since = new Date(Date.now() - cooldownDays * 86_400_000);
  const rows = await ctx.db
    .select({ title: nudges.title, content: nudges.content, createdAt: nudges.createdAt, fingerprint: nudges.fingerprint })
    .from(nudges)
    .where(and(eq(nudges.botId, botId), gt(nudges.createdAt, since)));
  const contentFp = fingerprint(content);
  const hit = rows.find((r) => r.fingerprint === fp || fingerprint(r.content) === contentFp);
  return hit ? { duplicate: true, fingerprint: fp, previousAt: hit.createdAt } : { duplicate: false, fingerprint: fp };
}

export async function createNudge(
  ctx: Ctx,
  input: { botId: string; kind: NudgeKind; title: string; content: string; fingerprint: string; status: NudgeStatus; messageId: string | null },
): Promise<NudgeDTO> {
  const [row] = await ctx.db
    .insert(nudges)
    .values({ ...input, deliveredAt: input.status === 'delivered' ? new Date() : null })
    .returning();
  const dto = nudgeToDTO(row!);
  await publish(ctx.sql, { type: 'nudge.created', nudge: dto });
  return dto;
}
