import { and, desc, eq, gt } from 'drizzle-orm';
import { APPROVAL_CATEGORY_LABELS, hostnameOf, type ApprovalCategory } from '@ant/shared';
import { approvals } from '../db/schema';
import { audit, botActor } from '../lib/audit';
import { createApproval } from '../services/approvals';
import { createMessage } from '../services/messages';
import { notifyOwner } from '../services/push';
import type { RunContext } from './run-context';

export interface ApprovalRequest {
  category: ApprovalCategory;
  tool: string;
  title?: string;
  summary: string;
  payload: Record<string, unknown>;
  screenshotPng?: string | null;
  urgent?: boolean;
}

/** Creates the approval card, posts it in the conversation and notifies the owner. Returns the text for the model. */
export async function requireApproval(rc: RunContext, req: ApprovalRequest): Promise<string> {
  const { ctx } = rc.deps;
  const approval = await createApproval(ctx, {
    runId: rc.run.id,
    botId: rc.bot.id,
    channelId: rc.run.channelId,
    threadRootId: rc.run.threadRootId,
    category: req.category,
    tool: req.tool,
    title: req.title,
    summary: req.summary,
    payload: req.payload,
    screenshotPng: req.screenshotPng ?? null,
    urgent: req.urgent ?? false,
    expiryHours: rc.settings.approvalExpiryHours,
  });
  rc.pendingApprovals.push(approval.id);
  if (rc.run.channelId) {
    await createMessage(ctx, {
      channelId: rc.run.channelId,
      threadRootId: rc.run.threadRootId,
      authorKind: 'system',
      botId: rc.bot.id,
      content: `🛡️ **Validation demandée** par @${rc.bot.slug} — ${approval.title}\n\n${req.summary}`,
      meta: { kind: 'approval', approvalId: approval.id, runId: rc.run.id },
    });
  }
  await notifyOwner(ctx, rc.deps.push, rc.settings, {
    title: `Validation : ${approval.title}`,
    body: `${rc.bot.name} — ${req.summary.slice(0, 160)}`,
    url: `/approvals?id=${approval.id}`,
    tag: `approval-${approval.id}`,
    approvalId: approval.id,
    urgent: req.urgent ?? false,
    level: 'warning',
  });
  await audit(ctx.db, {
    actor: botActor(rc.bot.slug),
    event: 'approval.requested',
    runId: rc.run.id,
    tool: req.tool,
    detail: { approvalId: approval.id, category: req.category, payload: req.payload },
    outcome: 'pending',
  });
  return `Action soumise à la validation du propriétaire (validation ${approval.id.slice(0, 8)} — ${APPROVAL_CATEGORY_LABELS[req.category]}). Elle sera exécutée exactement telle quelle s’il l’accepte, et tu seras relancé avec le résultat. Ne refais pas cette action et ne la contourne pas : termine ton tour en résumant ce qui attend sa validation.`;
}

/** An approved `request_approval` for a domain lets the bot act on that site for 30 minutes. */
export async function hasActiveGrant(rc: RunContext, url: string): Promise<boolean> {
  const host = hostnameOf(url);
  if (!host) return false;
  const since = new Date(Date.now() - 30 * 60_000);
  const rows = await rc.deps.ctx.db
    .select({ payload: approvals.payload })
    .from(approvals)
    .where(
      and(
        eq(approvals.botId, rc.bot.id),
        eq(approvals.tool, 'request_approval'),
        eq(approvals.status, 'executed'),
        gt(approvals.decidedAt, since),
      ),
    )
    .orderBy(desc(approvals.decidedAt))
    .limit(20);
  return rows.some((r) => {
    const domain = typeof r.payload.domain === 'string' ? r.payload.domain.toLowerCase().replace(/^\*\./, '') : '';
    return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
  });
}
