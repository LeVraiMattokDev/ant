import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MEMORY_KINDS } from '@ant/shared';
import { audit, botActor } from '../../lib/audit';
import { botCanEditMemory, createMemory, deleteMemory, searchMemoryForBot, updateMemory } from '../../services/memory';
import type { RunContext } from '../run-context';
import { clip, fail, guarded, ok } from './helpers';

export function memoryTools(rc: RunContext) {
  const { ctx } = rc.deps;
  const actor = botActor(rc.bot.slug);

  const search = tool(
    'memory_search',
    'Cherche dans la mémoire partagée (qui est le propriétaire, ses projets, ses préférences) et dans ta mémoire personnelle.',
    { query: z.string().max(500).describe('Mots-clés ; vide pour les éléments récents'), limit: z.number().int().min(1).max(30).optional() },
    async (args) =>
      guarded(async () => {
        const items = await searchMemoryForBot(ctx, rc.bot.id, args.query, args.limit ?? 10);
        if (items.length === 0) return ok('Aucun élément de mémoire trouvé.');
        return ok(
          clip(
            items
              .map((m) => `- (${m.scope === 'shared' ? 'partagé' : 'perso'} · ${m.kind}${m.pinned ? ' · épinglé' : ''}) ${m.title} : ${m.content} [id ${m.id}]`)
              .join('\n'),
          ),
        );
      }),
  );

  const write = tool(
    'memory_write',
    'Retient un fait durable, une préférence, un projet ou une décision. Pas de détails éphémères.',
    {
      scope: z.enum(['bot', 'shared']).describe('"bot" = ta mémoire ; "shared" = mémoire partagée de tous les bots'),
      kind: z.enum(MEMORY_KINDS),
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(5000),
      tags: z.array(z.string().max(40)).max(10).optional(),
      pinned: z.boolean().optional().describe('Épingler = toujours présent dans ton contexte. À réserver à l’essentiel.'),
      importance: z.number().int().min(1).max(5).optional(),
    },
    async (args) =>
      guarded(async () => {
        if (args.scope === 'shared' && !rc.permissions.sharedMemoryWrite) {
          return fail('Tu n’as pas le droit d’écrire dans la mémoire partagée : utilise scope "bot".');
        }
        const item = await createMemory(
          ctx,
          { ...args, botId: args.scope === 'bot' ? rc.bot.id : null },
          { kind: 'bot', botId: rc.bot.id },
        );
        await audit(ctx.db, { actor, event: 'memory.write', runId: rc.run.id, tool: 'memory_write', detail: { id: item.id, ...args } });
        return ok(`Mémorisé (id ${item.id}).`);
      }),
  );

  const update = tool(
    'memory_update',
    'Met à jour un élément de mémoire existant (par son id).',
    {
      id: z.string().uuid(),
      title: z.string().min(1).max(200).optional(),
      content: z.string().min(1).max(5000).optional(),
      tags: z.array(z.string().max(40)).max(10).optional(),
      pinned: z.boolean().optional(),
      importance: z.number().int().min(1).max(5).optional(),
    },
    async ({ id, ...patch }) =>
      guarded(async () => {
        await botCanEditMemory(ctx, rc.bot.id, id, rc.permissions.sharedMemoryWrite);
        await updateMemory(ctx, id, patch);
        await audit(ctx.db, { actor, event: 'memory.update', runId: rc.run.id, tool: 'memory_update', detail: { id, ...patch } });
        return ok('Mémoire mise à jour.');
      }),
  );

  const remove = tool('memory_delete', 'Supprime un élément de mémoire devenu faux ou inutile.', { id: z.string().uuid() }, async ({ id }) =>
    guarded(async () => {
      const row = await botCanEditMemory(ctx, rc.bot.id, id, rc.permissions.sharedMemoryWrite);
      await deleteMemory(ctx, id);
      await audit(ctx.db, { actor, event: 'memory.delete', runId: rc.run.id, tool: 'memory_delete', detail: { id, title: row.title } });
      return ok('Élément supprimé.');
    }),
  );

  return [search, write, update, remove];
}
