import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { audit, botActor } from '../../lib/audit';
import { createTask, listTasks, updateTask } from '../../services/tasks';
import type { RunContext } from '../run-context';
import { guarded, ok } from './helpers';

const status = z.enum(['open', 'waiting', 'done', 'dropped']);

export function taskTools(rc: RunContext) {
  const { ctx } = rc.deps;
  const actor = botActor(rc.bot.slug);

  const create = tool(
    'task_create',
    'Crée une tâche à suivre (revue lors de tes heartbeats).',
    {
      title: z.string().min(1).max(300),
      details: z.string().max(4000).optional(),
      due: z.string().optional().describe('Échéance ISO 8601, ex. 2026-11-03T09:00:00+01:00'),
    },
    async (args) =>
      guarded(async () => {
        const t = await createTask(ctx, { botId: rc.bot.id, title: args.title, details: args.details, dueAt: args.due ?? null });
        await audit(ctx.db, { actor, event: 'task.create', runId: rc.run.id, tool: 'task_create', detail: args });
        return ok(`Tâche créée (id ${t.id}).`);
      }),
  );

  const update = tool(
    'task_update',
    'Met à jour une de tes tâches (statut : open, waiting, done, dropped).',
    {
      id: z.string().uuid(),
      status: status.optional(),
      title: z.string().min(1).max(300).optional(),
      details: z.string().max(4000).optional(),
      due: z.string().nullable().optional(),
    },
    async ({ id, due, ...rest }) =>
      guarded(async () => {
        await updateTask(ctx, id, { ...rest, ...(due !== undefined ? { dueAt: due } : {}) }, rc.bot.id);
        await audit(ctx.db, { actor, event: 'task.update', runId: rc.run.id, tool: 'task_update', detail: { id, due, ...rest } });
        return ok('Tâche mise à jour.');
      }),
  );

  const list = tool('task_list', 'Liste tes tâches.', { status: z.array(status).optional() }, async (args) =>
    guarded(async () => {
      const items = await listTasks(ctx, { botId: rc.bot.id, status: args.status ?? ['open', 'waiting'] });
      if (items.length === 0) return ok('Aucune tâche.');
      return ok(items.map((t) => `- [${t.status}] ${t.title}${t.dueAt ? ` (échéance ${t.dueAt})` : ''} — id ${t.id}`).join('\n'));
    }),
  );

  return [create, update, list];
}
