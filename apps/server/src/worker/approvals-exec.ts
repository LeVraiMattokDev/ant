import { eq } from 'drizzle-orm';
import { hostnameOf, type BrowserRequest } from '@ant/shared';
import { bots } from '../db/schema';
import { audit, botActor } from '../lib/audit';
import { getSettings } from '../lib/settings';
import { approvalThreadKey, claimApprovalExecution, failApprovedApproval, getApproval, setApprovalStatus, strandedApprovals, type ApprovalRow } from '../services/approvals';
import { getComputerState, recordComputerAction } from '../services/computer-state';
import { createMessage } from '../services/messages';
import { notifyOwner } from '../services/push';
import { requestRun } from '../services/runs';
import type { WorkerDeps } from './deps';

function clip(text: string, max = 8000): string {
  return text.length > max ? `${text.slice(0, max)}\n… [tronqué]` : text;
}

export const INTERRUPTED_RESULT =
  'Interrompue : le worker a redémarré pendant l’exécution. L’action n’a PAS été relancée et son effet est inconnu : vérifie l’état réel avant de la redemander.';
export const NOT_STARTED_RESULT =
  'Non exécutée : l’exécution n’a pas pu démarrer (worker redémarré ou file de travaux interrompue). Rien n’a été fait ; redemande la validation si l’action est toujours nécessaire.';

/**
 * Executes exactly the parameters the owner approved, at most once, then wakes the bot up with the result.
 * The execution is claimed before anything is done: a job re-queued after a worker restart finds the claim
 * and closes the approval as interrupted instead of running the action a second time.
 */
export async function executeApproval(deps: WorkerDeps, approvalId: string): Promise<string> {
  const { ctx, computer } = deps;
  const approval = await claimApprovalExecution(ctx, approvalId);
  if (!approval) {
    const current = await getApproval(ctx, approvalId);
    if (current.status !== 'approved') return `statut ${current.status} : rien à exécuter`;
    // Approved but already claimed: an earlier attempt started the action and never finished.
    return (await closeStrandedApproval(deps, current)) ? 'failed' : `statut ${current.status} : rien à exécuter`;
  }
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
  await reportOutcome(deps, approval, failed, result, `${failed ? '⚠️' : '✅'} Validation « ${approval.title} » : ${failed ? 'échec' : 'exécutée'}.`);
  return failed ? 'failed' : 'executed';
}

/** Audit, system message in the conversation, and the bot woken up with the result in the session that asked. */
async function reportOutcome(deps: WorkerDeps, approval: ApprovalRow, failed: boolean, result: string, notice: string, detail: Record<string, unknown> = {}): Promise<void> {
  const { ctx } = deps;
  const bot = await ctx.db.query.bots.findFirst({ where: eq(bots.id, approval.botId) });
  await audit(ctx.db, {
    actor: bot ? botActor(bot.slug) : 'system',
    event: 'approval.executed',
    runId: approval.runId,
    tool: approval.tool,
    detail: { approvalId: approval.id, payload: approval.payload, result, ...detail },
    outcome: failed ? 'failed' : 'executed',
  });
  if (approval.channelId) {
    await createMessage(ctx, {
      channelId: approval.channelId,
      threadRootId: approval.threadRootId,
      authorKind: 'system',
      content: notice,
      meta: { kind: 'approval', approvalId: approval.id },
    });
  }
  if (bot && !bot.paused && !bot.archivedAt) {
    await requestRun(ctx, {
      botId: bot.id,
      channelId: approval.channelId,
      threadRootId: approval.threadRootId,
      threadKey: await approvalThreadKey(ctx, approval),
      trigger: 'approval',
      priority: 'interactive',
      origin: 'user',
      prompt: `Le propriétaire a validé ta demande « ${approval.title} ».\nRésultat de l’exécution :\n${result}\n\nPoursuis la tâche en tenant compte de ce résultat.${approval.comment ? `\nCommentaire du propriétaire : ${approval.comment}` : ''}`,
      payload: { approvalId: approval.id },
    });
  }
}

/**
 * Closes, as failed and without ever running it, an approved action that no job will finish:
 * started and interrupted (effect unknown: the owner is told to check), or lost before it started.
 * Returns false when the approval was closed by someone else in the meantime.
 */
async function closeStrandedApproval(deps: WorkerDeps, approval: ApprovalRow): Promise<boolean> {
  const started = approval.executedAt !== null;
  const result = started ? INTERRUPTED_RESULT : NOT_STARTED_RESULT;
  const closed = await failApprovedApproval(deps.ctx, approval.id, result);
  if (!closed) return false;
  const notice = started
    ? `⚠️ Validation « ${closed.title} » : interrompue par un redémarrage du worker, état inconnu. Elle n’a pas été relancée : vérifie le résultat avant de la redemander.`
    : `⚠️ Validation « ${closed.title} » : non exécutée, l’exécution n’a pas pu démarrer. Rien n’a été fait.`;
  await reportOutcome(deps, closed, true, result, notice, started ? { interrupted: true } : { notStarted: true });
  if (started) {
    const settings = await getSettings(deps.ctx.db);
    await notifyOwner(deps.ctx, deps.push, settings, {
      title: `Validation interrompue : ${closed.title}`,
      body: 'Le worker a redémarré pendant l’exécution. L’action n’a pas été relancée et son effet est inconnu : vérifie avant de la redemander.',
      url: `/approvals?id=${closed.id}`,
      tag: `approval-${closed.id}`,
      level: 'warning',
    });
  }
  return true;
}

/**
 * Scheduler pass: approved actions whose job is gone (failed by the start-up recovery after a restart,
 * or lost before it ran) are closed instead of staying « validée » forever. Never replays an action.
 */
export async function closeStrandedApprovals(deps: WorkerDeps, now = new Date()): Promise<number> {
  let closed = 0;
  for (const approval of await strandedApprovals(deps.ctx, now)) {
    try {
      if (await closeStrandedApproval(deps, approval)) closed++;
    } catch (err) {
      // Closing comes first, so a failing notice is not retried; the rest of the scheduler pass goes on.
      deps.log.error({ err, approvalId: approval.id }, 'could not report a stranded approval');
    }
  }
  return closed;
}
