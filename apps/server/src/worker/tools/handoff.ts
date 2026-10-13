import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { performHandoff } from '../handoff';
import type { RunContext } from '../run-context';
import { fail, guarded, ok } from './helpers';

/** Hand-off of a task to another bot of the conversation. */
export function handoffTools(rc: RunContext) {
  const handoff = tool(
    'handoff',
    'Confie une tâche à un autre bot dans la conversation en cours. Il travaillera en parallèle et répondra ici.',
    {
      bot: z.string().describe('Identifiant du bot destinataire, sans @ (voir list_bots)'),
      task: z.string().min(3).max(4000).describe('Ce que le bot doit faire, de façon autonome'),
      context: z.string().max(12_000).optional().describe('Informations utiles dont il aura besoin'),
    },
    async (args) =>
      guarded(async () => {
        if (!rc.permissions.handoff) return fail('Tu n’as pas la permission de transférer des tâches.');
        if (!rc.run.channelId) return fail('Aucune conversation associée à cette exécution.');
        const target = rc.botsBySlug.get(args.bot.replace(/^@/, '').toLowerCase());
        if (!target) return fail(`Bot « ${args.bot} » introuvable. Bots disponibles : ${[...rc.botsBySlug.keys()].join(', ')}`);
        const res = await performHandoff(rc.deps, rc.settings, {
          fromRun: rc.run,
          fromBot: { id: rc.bot.id, slug: rc.bot.slug, name: rc.bot.name },
          toBotId: target.id,
          channelId: rc.run.channelId,
          threadRootId: rc.run.threadRootId,
          task: args.task,
          context: args.context,
        });
        return res.ok ? ok(`Tâche confiée à @${res.toSlug}. Il répondra dans cette conversation.`) : fail(`Transfert refusé : ${res.reason}`);
      }),
  );

  return [handoff];
}
