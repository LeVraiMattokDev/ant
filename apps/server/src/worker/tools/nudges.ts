import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { NUDGE_KINDS, type NudgeKind } from '@ant/shared';
import { audit, botActor } from '../../lib/audit';
import { dmChannelId } from '../../services/bots';
import { createMessage, updateMessage } from '../../services/messages';
import { checkDuplicate, createNudge } from '../../services/nudges';
import { notifyOwner } from '../../services/push';
import type { RunContext } from '../run-context';
import { fail, guarded, ok } from './helpers';

const KIND_LABELS: Record<NudgeKind, string> = {
  idee: '💡 Idée',
  risque: '⚠️ Risque',
  oubli: '📌 Oubli',
  etape: '➡️ Prochaine étape',
  opportunite: '🎯 Opportunité',
};

/** Only offered during heartbeat runs. */
export function nudgeTools(rc: RunContext) {
  let created = 0;
  return [
    tool(
      'nudge_create',
      'Envoie une relance proactive au propriétaire (idée, risque, oubli, prochaine étape, opportunité). Maximum 3 par heartbeat. Seulement si elle est concrète, utile et nouvelle.',
      {
        kind: z.enum(NUDGE_KINDS),
        title: z.string().min(5).max(140),
        content: z.string().min(20).max(3000).describe('Pourquoi c’est important maintenant et ce que tu proposes de faire'),
      },
      async (args) =>
        guarded(async () => {
          if (created >= 3) return fail('Maximum de 3 relances par heartbeat atteint.');
          const dup = await checkDuplicate(rc.deps.ctx, rc.bot.id, args.title, args.content, rc.settings.nudgeCooldownDays);
          if (dup.duplicate) {
            return fail(`Relance trop proche d’une relance du ${dup.previousAt.toISOString().slice(0, 10)} : ne la répète pas, trouve autre chose ou arrête-toi.`);
          }
          const channelId = await dmChannelId(rc.deps.ctx, rc.bot.id);
          const message = await createMessage(rc.deps.ctx, {
            channelId,
            authorKind: 'bot',
            botId: rc.bot.id,
            content: `**${KIND_LABELS[args.kind]} — ${args.title}**\n\n${args.content}`,
            meta: { kind: 'nudge', runId: rc.run.id, model: rc.run.model, effort: rc.run.effort, computeSource: rc.computeSource },
          });
          const nudge = await createNudge(rc.deps.ctx, {
            botId: rc.bot.id,
            kind: args.kind,
            title: args.title,
            content: args.content,
            fingerprint: dup.fingerprint,
            status: 'delivered',
            messageId: message.id,
          });
          await updateMessage(rc.deps.ctx, message.id, { meta: { nudgeId: nudge.id } });
          await notifyOwner(rc.deps.ctx, rc.deps.push, rc.settings, {
            title: `${rc.bot.name} : ${args.title}`,
            body: args.content.slice(0, 180),
            url: `/c/${channelId}`,
            tag: `nudge-${nudge.id}`,
          });
          await audit(rc.deps.ctx.db, { actor: botActor(rc.bot.slug), event: 'nudge', runId: rc.run.id, tool: 'nudge_create', detail: args });
          created++;
          return ok('Relance envoyée.');
        }),
    ),
  ];
}
