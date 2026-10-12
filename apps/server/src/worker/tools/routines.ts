import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { describeCron } from '@ant/shared';
import { audit, botActor } from '../../lib/audit';
import { createMessage } from '../../services/messages';
import { createRoutine } from '../../services/routines';
import type { RunContext } from '../run-context';
import { guarded, ok } from './helpers';

export function routineTools(rc: RunContext) {
  return [
    tool(
      'routine_propose',
      'Propose une routine planifiée quand le propriétaire demande une tâche récurrente (« chaque lundi à 8h, fais-moi un point sur… »). Elle est créée désactivée : le propriétaire la confirme dans l’écran Routines.',
      {
        cron: z.string().describe('Expression cron à 5 champs, heure locale du propriétaire, ex. "0 8 * * 1"'),
        instruction: z.string().min(5).max(4000).describe('Ce que tu devras faire à chaque exécution'),
        source_text: z.string().max(1000).describe('La demande du propriétaire, mot pour mot'),
        urgent: z.boolean().optional().describe('true seulement si elle doit passer même quand la réserve d’abonnement est atteinte'),
      },
      async (args) =>
        guarded(async () => {
          const routine = await createRoutine(
            rc.deps.ctx,
            {
              botId: rc.bot.id,
              channelId: rc.run.channelId,
              sourceText: args.source_text,
              cron: args.cron,
              instruction: args.instruction,
              urgent: args.urgent ?? false,
              enabled: false,
            },
            rc.settings.timezone,
          );
          if (rc.run.channelId) {
            await createMessage(rc.deps.ctx, {
              channelId: rc.run.channelId,
              threadRootId: rc.run.threadRootId,
              authorKind: 'system',
              botId: rc.bot.id,
              content: `🗓️ Routine proposée par @${rc.bot.slug} : **${describeCron(routine.cron)}** (${routine.timezone}) — « ${routine.instruction} ». Active-la dans l’écran Routines.`,
              meta: { kind: 'routine', routineId: routine.id },
            });
          }
          await audit(rc.deps.ctx.db, { actor: botActor(rc.bot.slug), event: 'routine.propose', runId: rc.run.id, tool: 'routine_propose', detail: args });
          return ok(`Routine proposée (${describeCron(routine.cron)}). Le propriétaire doit l’activer dans l’écran Routines.`);
        }),
    ),
  ];
}
