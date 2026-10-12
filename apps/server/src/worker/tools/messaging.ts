import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { channels } from '../../db/schema';
import { audit, botActor } from '../../lib/audit';
import { channelBotIds } from '../../services/channels';
import { createMessage, searchMessages } from '../../services/messages';
import { performHandoff } from '../handoff';
import type { RunContext } from '../run-context';
import { clip, fail, guarded, ok } from './helpers';

export function messagingTools(rc: RunContext) {
  const { ctx } = rc.deps;

  const postMessage = tool(
    'post_message',
    'Publie un message intermédiaire dans la conversation en cours (point d’étape) ou dans un autre canal où tu es membre. Ta réponse finale est publiée automatiquement : n’utilise pas cet outil pour elle.',
    {
      text: z.string().min(1).max(20_000).describe('Contenu Markdown'),
      channel: z.string().optional().describe('Nom d’un autre canal de groupe dont tu es membre (par défaut : la conversation en cours)'),
    },
    async (args) =>
      guarded(async () => {
        let channelId = rc.run.channelId;
        let threadRootId = rc.run.threadRootId;
        if (args.channel) {
          const target = await ctx.db.query.channels.findFirst({
            where: and(eq(channels.name, args.channel), eq(channels.kind, 'group'), isNull(channels.archivedAt)),
          });
          if (!target) return fail(`Canal « ${args.channel} » introuvable.`);
          const members = await channelBotIds(ctx, target.id);
          if (!members.includes(rc.bot.id)) return fail(`Tu n’es pas membre du canal « ${args.channel} ».`);
          channelId = target.id;
          threadRootId = null;
        }
        if (!channelId) return fail('Aucune conversation associée à cette exécution.');
        const msg = await createMessage(ctx, {
          channelId,
          threadRootId,
          authorKind: 'bot',
          botId: rc.bot.id,
          content: args.text,
          meta: { kind: 'chat', runId: rc.run.id, model: rc.run.model, effort: rc.run.effort, computeSource: rc.computeSource },
        });
        return ok(`Message publié (id ${msg.id}).`);
      }),
  );

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

  const listBots = tool('list_bots', 'Liste les autres bots d’Ant, leur identifiant et leur rôle.', {}, async () =>
    ok(
      [...rc.botsBySlug.entries()]
        .filter(([, b]) => b.id !== rc.bot.id)
        .map(([slug, b]) => `@${slug} — ${b.name} : ${b.role}`)
        .join('\n') || 'Aucun autre bot.',
    ),
  );

  const search = tool(
    'search_messages',
    'Recherche plein texte dans tout l’historique des conversations (syntaxe : mots, "expression exacte", -exclusion, or).',
    { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(30).optional() },
    async (args) =>
      guarded(async () => {
        const results = await searchMessages(ctx, args.query, { limit: args.limit ?? 10 });
        await audit(ctx.db, { actor: botActor(rc.bot.slug), event: 'tool', runId: rc.run.id, tool: 'search_messages', detail: args });
        if (results.length === 0) return ok('Aucun résultat.');
        return ok(
          clip(
            results
              .map((r) => `- [${r.message.createdAt.slice(0, 16)} · #${r.channelName}] ${r.message.authorKind === 'user' ? 'propriétaire' : r.message.authorKind} : ${r.snippet}`)
              .join('\n'),
          ),
        );
      }),
  );

  return [postMessage, handoff, listBots, search];
}

