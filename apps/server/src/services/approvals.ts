import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, lt, or, sql as dsql } from 'drizzle-orm';
import { APPROVAL_CATEGORY_LABELS, type ApprovalCategory, type ApprovalDTO, type ApprovalStatus } from '@ant/shared';
import { approvals, runs } from '../db/schema';
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

const { screenshotPng: _screenshot, ...listColumns } = getTableColumns(approvals);

/** The list never needs the captures themselves (served by their own route): only whether one exists. */
export async function listApprovals(ctx: Ctx, statuses?: ApprovalStatus[]): Promise<ApprovalDTO[]> {
  const rows = await ctx.db
    .select({ ...listColumns, hasScreenshot: dsql<boolean>`${approvals.screenshotPng} is not null` })
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

/**
 * Claims the execution of an approved action, before anything is done. `executed_at` marks the start:
 * only one caller gets the row, so an action re-queued after a worker restart is never run a second time.
 * Returns null when the approval is not approved any more, or when its execution already started.
 */
export async function claimApprovalExecution(ctx: Ctx, id: string, now = new Date()): Promise<ApprovalRow | null> {
  const [row] = await ctx.db
    .update(approvals)
    .set({ executedAt: now })
    .where(and(eq(approvals.id, id), eq(approvals.status, 'approved'), isNull(approvals.executedAt)))
    .returning();
  return row ?? null;
}

/**
 * Approved actions that no job will finish any more: their `approval.execute` job is neither pending nor running.
 * - started (`executed_at` set): the worker stopped during the action, whose effect is unknown;
 * - never started: the job was lost before the action began (checked only after `graceMs`, so that the
 *   job the web service enqueues right after the decision is never mistaken for a lost one).
 */
export async function strandedApprovals(ctx: Ctx, now = new Date(), graceMs = 2 * 60_000): Promise<ApprovalRow[]> {
  return ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.status, 'approved'),
        or(isNotNull(approvals.executedAt), lt(approvals.decidedAt, new Date(now.getTime() - graceMs))),
        dsql`not exists (select 1 from jobs j where j.kind = 'approval.execute' and j.status in ('pending', 'running') and j.payload->>'approvalId' = ${approvals.id}::text)`,
      ),
    )
    .limit(50);
}

/** Closes an approval that is still `approved` as failed. Atomic: returns null when someone else closed it first. */
export async function failApprovedApproval(ctx: Ctx, id: string, result: string): Promise<ApprovalRow | null> {
  const [row] = await ctx.db
    .update(approvals)
    .set({ status: 'failed', result: result.slice(0, 20_000), executedAt: dsql`coalesce(${approvals.executedAt}, now())` })
    .where(and(eq(approvals.id, id), eq(approvals.status, 'approved')))
    .returning();
  if (!row) return null;
  await publish(ctx.sql, { type: 'approval.updated', approval: approvalToDTO(row) });
  return row;
}

/**
 * Agent session key of the run that asked for the approval: the bot is woken up with the outcome in
 * that session (a routine or a heartbeat has its own, not the conversation's). Undefined when the
 * request came from no run or its run is gone: the default key of the approval's conversation applies.
 */
export async function approvalThreadKey(ctx: Ctx, approval: Pick<ApprovalRow, 'runId'>): Promise<string | undefined> {
  if (!approval.runId) return undefined;
  const run = await ctx.db.query.runs.findFirst({ columns: { threadKey: true }, where: eq(runs.id, approval.runId) });
  return run?.threadKey;
}
