import { eq } from 'drizzle-orm';
import { hostnameOf, type BrowserRequest } from '@ant/shared';
import { bots } from '../db/schema';
import { audit, botActor } from '../lib/audit';
import { getApproval, setApprovalStatus } from '../services/approvals';
import { getComputerState, recordComputerAction } from '../services/computer-state';
import { createMessage } from '../services/messages';
import { requestRun } from '../services/runs';
import type { WorkerDeps } from './deps';

function clip(text: string, max = 8000): string {
  return text.length > max ? `${text.slice(0, max)}\n… [tronqué]` : text;
}

/** Executes exactly the parameters the owner approved, then wakes the bot up with the result. */
export async function executeApproval(deps: WorkerDeps, approvalId: string): Promise<string> {
  const { ctx, computer } = deps;
  const approval = await getApproval(ctx, approvalId);
  if (approval.status !== 'approved') return `statut ${approval.status} : rien à exécuter`;
  const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, approval.botId) });
  const p = approval.payload;
  let result = '';
  let failed = false;
  try {
    if (approval.tool === 'computer_exec') {
      const state = await getComputerState(ctx);
      if (state.holder === 'user') throw new Error('le propriétaire a la main sur l’ordinateur ; rends-la aux agents puis relance');
      const res = await computer.exec({
        command: String(p.command),
        cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
        timeoutSec: typeof p.timeoutSec === 'number' ? Math.min(p.timeoutSec, 280) : 120,
      });
      await recordComputerAction(ctx, approval.botId, `$ ${String(p.command).slice(0, 200)} (validée)`);
      failed = res.exitCode !== 0;
      result = clip(`Code de sortie : ${res.exitCode}${res.timedOut ? ' (délai dépassé)' : ''}\n${res.stdout ? `--- stdout ---\n${res.stdout}\n` : ''}${res.stderr ? `--- stderr ---\n${res.stderr}` : ''}`);
    } else if (approval.tool === 'browser') {
      const state = await getComputerState(ctx);
      if (state.holder === 'user') throw new Error('le propriétaire a la main sur l’ordinateur ; rends-la aux agents puis relance');
      const current = await computer.browser({ action: 'screenshot', screenshot: false });
      const expected = String(p.expectedUrl ?? '');
      if (hostnameOf(current.url) !== hostnameOf(expected)) {
        throw new Error(`le navigateur n’est plus sur ${hostnameOf(expected)} (page actuelle : ${current.url}) — action non exécutée`);
      }
      if (p.action === 'click' && typeof p.expectedLabel === 'string') {
        const target = await computer.inspect({ ref: typeof p.ref === 'string' ? p.ref : undefined, selector: typeof p.selector === 'string' ? p.selector : undefined });
        if ((target.elementLabel ?? '') !== p.expectedLabel) {
          throw new Error(`l’élément ciblé a changé (« ${target.elementLabel ?? '?'} » au lieu de « ${p.expectedLabel} ») — action non exécutée`);
        }
      }
      const req: BrowserRequest = {
        action: p.action as BrowserRequest['action'],
        ref: typeof p.ref === 'string' ? p.ref : undefined,
        selector: typeof p.selector === 'string' ? p.selector : undefined,
        text: typeof p.text === 'string' ? p.text : undefined,
        key: typeof p.key === 'string' ? p.key : undefined,
      };
      const res = await computer.browser(req);
      await recordComputerAction(ctx, approval.botId, `navigateur : ${req.action} (validée)`, res.url);
      failed = !res.ok;
      result = res.ok ? `Action effectuée. Page actuelle : ${res.title} — ${res.url}` : `Échec : ${res.error ?? 'inconnu'}`;
    } else if (approval.tool === 'request_approval') {
      result = typeof p.domain === 'string' && p.domain
        ? `Validé. Tu peux agir sur ${p.domain} pendant 30 minutes, exactement comme décrit.`
        : 'Validé. Tu peux procéder exactement comme décrit.';
    } else {
      throw new Error(`outil inconnu : ${approval.tool}`);
    }
  } catch (err) {
    failed = true;
    result = `Non exécuté : ${(err as Error).message}`;
  }

  await setApprovalStatus(ctx, approval.id, failed ? 'failed' : 'executed', { result });
  await audit(ctx.db, {
    actor: bot ? botActor(bot.slug) : 'system',
    event: 'approval.executed',
    runId: approval.runId,
    tool: approval.tool,
    detail: { approvalId: approval.id, payload: approval.payload, result },
    outcome: failed ? 'failed' : 'executed',
  });
  if (approval.channelId) {
    await createMessage(ctx, {
      channelId: approval.channelId,
      threadRootId: approval.threadRootId,
      authorKind: 'system',
      content: `${failed ? '⚠️' : '✅'} Validation « ${approval.title} » : ${failed ? 'échec' : 'exécutée'}.`,
      meta: { kind: 'approval', approvalId: approval.id },
    });
  }
  if (bot && !bot.paused) {
    await requestRun(ctx, {
      botId: bot.id,
      channelId: approval.channelId,
      threadRootId: approval.threadRootId,
      trigger: 'approval',
      priority: 'interactive',
      origin: 'user',
      prompt: `Le propriétaire a validé ta demande « ${approval.title} ».\nRésultat de l’exécution :\n${result}\n\nPoursuis la tâche en tenant compte de ce résultat.${approval.comment ? `\nCommentaire du propriétaire : ${approval.comment}` : ''}`,
      payload: { approvalId: approval.id },
    });
  }
  return failed ? 'failed' : 'executed';
}
