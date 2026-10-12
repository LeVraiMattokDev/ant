import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApprovalStatus } from '@ant/shared';
import { approvalToDTO } from '../../lib/dto';
import { audit } from '../../lib/audit';
import { HttpError } from '../../lib/errors';
import { enqueue } from '../../lib/jobs';
import { decideApproval, getApproval, listApprovals } from '../../services/approvals';
import { createMessage } from '../../services/messages';
import { requestRun } from '../../services/runs';
import type { WebDeps } from '../deps';

const STATUSES: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired', 'executed', 'failed'];

export async function approvalRoutes(app: FastifyInstance, deps: WebDeps): Promise<void> {
  const { ctx } = deps;

  app.get<{ Querystring: { status?: string } }>('/api/approvals', async (req) => {
    const statuses = (req.query.status ?? '').split(',').filter((s): s is ApprovalStatus => (STATUSES as string[]).includes(s));
    return listApprovals(ctx, statuses.length ? statuses : undefined);
  });

  app.get<{ Params: { id: string } }>('/api/approvals/:id/screenshot', async (req, reply) => {
    const approval = await getApproval(ctx, req.params.id);
    if (!approval.screenshotPng) throw new HttpError(404, 'no_screenshot', 'Pas de capture pour cette validation.');
    return reply.type('image/png').header('cache-control', 'private, max-age=3600').send(Buffer.from(approval.screenshotPng, 'base64'));
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id/decide', async (req) => {
    const body = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).optional() }).parse(req.body);
    const current = await getApproval(ctx, req.params.id);
    if (current.status !== 'pending') throw new HttpError(409, 'already_decided', `Cette validation n’est plus en attente (${current.status}).`);
    if (current.expiresAt.getTime() < Date.now()) throw new HttpError(409, 'expired', 'Cette validation a expiré.');
    const decided = await decideApproval(ctx, current.id, body.decision, body.comment?.trim() || null);
    if (!decided) throw new HttpError(409, 'already_decided', 'Cette validation vient d’être traitée.');
    await audit(ctx.db, {
      actor: 'owner',
      event: body.decision === 'approve' ? 'approval.approved' : 'approval.rejected',
      runId: decided.runId,
      tool: decided.tool,
      detail: { approvalId: decided.id, comment: body.comment },
      ip: req.ip,
    });
    if (body.decision === 'approve') {
      await enqueue(ctx.db, 'approval.execute', { approvalId: decided.id }, { dedupeKey: `approval:${decided.id}`, maxAttempts: 1 });
    } else {
      if (decided.channelId) {
        await createMessage(ctx, {
          channelId: decided.channelId,
          threadRootId: decided.threadRootId,
          authorKind: 'system',
          content: `🚫 Validation « ${decided.title} » refusée${body.comment ? ` : ${body.comment}` : ''}.`,
          meta: { kind: 'approval', approvalId: decided.id },
        });
      }
      await requestRun(ctx, {
        botId: decided.botId,
        channelId: decided.channelId,
        threadRootId: decided.threadRootId,
        trigger: 'approval',
        priority: 'interactive',
        origin: 'user',
        prompt: `Le propriétaire a REFUSÉ ta demande « ${decided.title} ». Ne fais pas cette action et ne la contourne pas.${body.comment ? `\nSon commentaire : ${body.comment}` : ''}\nAdapte ton plan et dis-lui brièvement comment tu continues.`,
        payload: { approvalId: decided.id },
      });
    }
    return approvalToDTO(decided);
  });
}
