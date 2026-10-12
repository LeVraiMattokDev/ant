import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { APPROVAL_CATEGORY_LABELS, type ApprovalCategory, type ApprovalDTO, type ApprovalStatus } from '@ant/shared';
import { approvals } from '../db/schema';
import { approvalToDTO } from '../lib/dto';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import type { Ctx } from './context';

export type ApprovalRow = typeof approvals.$inferSelect;

export interface NewApproval {
  runId: string | null;
  botId: string;
  channelId: string | null;
  threadRootId: string | null;
  category: ApprovalCategory;
  tool: string;
  title?: string;
  summary: string;
  payload: Record<string, unknown>;
  screenshotPng?: string | null;
  urgent?: boolean;
  expiryHours: number;
}

export async function createApproval(ctx: Ctx, input: NewApproval): Promise<ApprovalDTO> {
  const [row] = await ctx.db
    .insert(approvals)
    .values({
      runId: input.runId,
      botId: input.botId,
      channelId: input.channelId,
      threadRootId: input.threadRootId,
      category: input.category,
      tool: input.tool,
      title: input.title ?? APPROVAL_CATEGORY_LABELS[input.category],
      summary: input.summary.slice(0, 4000),
      payload: input.payload,
      screenshotPng: input.screenshotPng ?? null,
      urgent: input.urgent ?? false,
      expiresAt: new Date(Date.now() + input.expiryHours * 3600_000),
    })
    .returning();
  const dto = approvalToDTO(row!);
  await publish(ctx.sql, { type: 'approval.updated', approval: dto });
  return dto;
}

export async function getApproval(ctx: Ctx, id: string): Promise<ApprovalRow> {
  const row = await ctx.db.query.approvals.findFirst({ where: eq(approvals.id, id) });
  if (!row) throw new HttpError(404, 'not_found', 'Validation introuvable.');
  return row;
}

export async function listApprovals(ctx: Ctx, statuses?: ApprovalStatus[]): Promise<ApprovalDTO[]> {
  const rows = await ctx.db
    .select()
    .from(approvals)
    .where(statuses?.length ? inArray(approvals.status, statuses) : undefined)
    .orderBy(desc(approvals.createdAt))
    .limit(200);
  return rows.map(approvalToDTO);
}

export async function setApprovalStatus(
  ctx: Ctx,
  id: string,
  status: ApprovalStatus,
  extra: { comment?: string | null; result?: string | null } = {},
): Promise<ApprovalDTO> {
  const now = new Date();
  const [row] = await ctx.db
    .update(approvals)
    .set({
      status,
      ...(extra.comment !== undefined ? { comment: extra.comment } : {}),
      ...(extra.result !== undefined ? { result: extra.result?.slice(0, 20_000) ?? null } : {}),
      ...(status === 'approved' || status === 'rejected' ? { decidedAt: now } : {}),
      ...(status === 'executed' || status === 'failed' ? { executedAt: now } : {}),
    })
    .where(eq(approvals.id, id))
    .returning();
  if (!row) throw new HttpError(404, 'not_found', 'Validation introuvable.');
  const dto = approvalToDTO(row);
  await publish(ctx.sql, { type: 'approval.updated', approval: dto });
  return dto;
}

/**
 * Atomically moves a pending approval to approved/rejected. Returns null when it was
 * no longer pending (double click, expiry), so an action is never executed twice.
 */
export async function decideApproval(ctx: Ctx, id: string, decision: 'approve' | 'reject', comment: string | null): Promise<ApprovalRow | null> {
  const [row] = await ctx.db
    .update(approvals)
    .set({ status: decision === 'approve' ? 'approved' : 'rejected', comment, decidedAt: new Date() })
    .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
    .returning();
  if (row) await publish(ctx.sql, { type: 'approval.updated', approval: approvalToDTO(row) });
  return row ?? null;
}

export async function expireApprovals(ctx: Ctx, now = new Date()): Promise<ApprovalRow[]> {
  const rows = await ctx.db
    .update(approvals)
    .set({ status: 'expired' })
    .where(and(eq(approvals.status, 'pending'), lt(approvals.expiresAt, now)))
    .returning();
  for (const r of rows) await publish(ctx.sql, { type: 'approval.updated', approval: approvalToDTO(r) });
  return rows;
}
