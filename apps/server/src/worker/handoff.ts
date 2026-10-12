import { asc, eq } from 'drizzle-orm';
import { checkHandoff, type AppSettings } from '@ant/shared';
import { bots, handoffs } from '../db/schema';
import { audit, botActor } from '../lib/audit';
import { createMessage } from '../services/messages';
import { requestRun, type RunRow } from '../services/runs';
import type { WorkerDeps } from './deps';

export interface HandoffInput {
  fromRun: RunRow;
  fromBot: { id: string; slug: string; name: string };
  toBotId: string;
  channelId: string;
  threadRootId: string | null;
  task: string;
  context?: string;
  /** Hand-off created by an @mention in the bot's message (no extra announcement). */
  viaMention?: boolean;
}

export type HandoffResult = { ok: true; runId: string; toSlug: string } | { ok: false; reason: string };

export async function performHandoff(deps: WorkerDeps, settings: AppSettings, input: HandoffInput): Promise<HandoffResult> {
  const { ctx } = deps;
  const target = await ctx.db.query.bots.findFirst({ where: eq(bots.id, input.toBotId) });
  if (!target || target.archivedAt) return { ok: false, reason: 'bot destinataire introuvable' };
  if (target.paused) return { ok: false, reason: `${target.name} est en pause` };

  const history = await ctx.db
    .select({ from: handoffs.fromBotId, to: handoffs.toBotId })
    .from(handoffs)
    .where(eq(handoffs.chainId, input.fromRun.chainId))
    .orderBy(asc(handoffs.createdAt));
  const check = checkHandoff({
    hop: input.fromRun.hop,
    maxHops: settings.maxHandoffHops,
    history,
    next: { from: input.fromBot.id, to: target.id },
  });
  if (!check.allowed) {
    await createMessage(ctx, {
      channelId: input.channelId,
      threadRootId: input.threadRootId,
      authorKind: 'system',
      content: `Transfert de @${input.fromBot.slug} vers @${target.slug} bloqué : ${check.reason}. Réponds dans ce fil pour relancer la discussion.`,
      meta: { kind: 'info' },
    });
    await audit(ctx.db, {
      actor: botActor(input.fromBot.slug),
      event: 'handoff.blocked',
      runId: input.fromRun.id,
      detail: { to: target.slug, reason: check.reason },
      outcome: 'blocked',
    });
    return { ok: false, reason: check.reason };
  }

  if (!input.viaMention) {
    await createMessage(ctx, {
      channelId: input.channelId,
      threadRootId: input.threadRootId,
      authorKind: 'system',
      content: `↪ @${input.fromBot.slug} confie à @${target.slug} : ${input.task}`,
      meta: { kind: 'handoff', handoff: { fromBotId: input.fromBot.id, toBotId: target.id } },
    });
  }
  const prompt = [
    `@${input.fromBot.slug} (${input.fromBot.name}) te ${input.viaMention ? 'mentionne' : 'confie une tâche'} :`,
    input.task,
    input.context ? `\nContexte fourni :\n${input.context}` : '',
    '\nRéponds dans cette conversation. Si tu as besoin d’une précision du propriétaire, demande-la simplement.',
  ]
    .filter(Boolean)
    .join('\n');
  const run = await requestRun(ctx, {
    botId: target.id,
    channelId: input.channelId,
    threadRootId: input.threadRootId,
    trigger: 'handoff',
    priority: 'normal',
    origin: input.fromRun.origin,
    chainId: input.fromRun.chainId,
    hop: input.fromRun.hop + 1,
    prompt,
    payload: { handoffFromBotId: input.fromBot.id },
  });
  if (!run) return { ok: false, reason: `${target.name} ne peut pas recevoir de tâche` };
  await ctx.db.insert(handoffs).values({ chainId: input.fromRun.chainId, fromBotId: input.fromBot.id, toBotId: target.id, runId: run.id });
  await audit(ctx.db, {
    actor: botActor(input.fromBot.slug),
    event: 'handoff',
    runId: input.fromRun.id,
    detail: { to: target.slug, task: input.task, hop: input.fromRun.hop + 1 },
    outcome: 'queued',
  });
  return { ok: true, runId: run.id, toSlug: target.slug };
}
