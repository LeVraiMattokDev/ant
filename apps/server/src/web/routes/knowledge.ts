import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMORY_KINDS, type MemoryInput, type TaskStatus } from '@ant/shared';
import { audit } from '../../lib/audit';
import { createMemory, deleteMemory, listMemory, updateMemory } from '../../services/memory';
import { listNudges, setNudgeStatus } from '../../services/nudges';
import { createTask, deleteTask, listTasks, updateTask } from '../../services/tasks';
import type { WebDeps } from '../deps';

const memoryInput = z.object({
  scope: z.enum(['shared', 'bot']),
  botId: z.string().uuid().nullable().optional(),
  kind: z.enum(MEMORY_KINDS),
  title: z.string().min(1).max(200),
  content: z.string().max(20_000),
  tags: z.array(z.string().max(40)).max(20).optional(),
  pinned: z.boolean().optional(),
  importance: z.number().int().min(1).max(5).optional(),
});

const taskStatus = z.enum(['open', 'waiting', 'done', 'dropped']);

export async function knowledgeRoutes(app: FastifyInstance, deps: WebDeps): Promise<void> {
  const { ctx } = deps;

  app.get<{ Querystring: { scope?: string; botId?: string; q?: string; kind?: string } }>('/api/memory', async (req) =>
    listMemory(ctx, {
      scope: req.query.scope === 'shared' || req.query.scope === 'bot' ? req.query.scope : undefined,
      botId: req.query.botId || undefined,
      q: req.query.q,
      kind: (MEMORY_KINDS as readonly string[]).includes(req.query.kind ?? '') ? (req.query.kind as MemoryInput['kind']) : undefined,
    }),
  );

  app.post('/api/memory', async (req) => {
    const item = await createMemory(ctx, memoryInput.parse(req.body) as MemoryInput, { kind: 'user' });
    await audit(ctx.db, { actor: 'owner', event: 'memory.write', detail: { id: item.id, title: item.title }, ip: req.ip });
    return item;
  });

  app.patch<{ Params: { id: string } }>('/api/memory/:id', async (req) => {
    const item = await updateMemory(ctx, req.params.id, memoryInput.partial().parse(req.body) as Partial<MemoryInput>);
    await audit(ctx.db, { actor: 'owner', event: 'memory.update', detail: { id: item.id }, ip: req.ip });
    return item;
  });

  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (req) => {
    await deleteMemory(ctx, req.params.id);
    await audit(ctx.db, { actor: 'owner', event: 'memory.delete', detail: { id: req.params.id }, ip: req.ip });
    return { ok: true };
  });

  app.get<{ Querystring: { botId?: string; status?: string } }>('/api/tasks', async (req) => {
    const statuses = (req.query.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is TaskStatus => taskStatus.safeParse(s).success);
    return listTasks(ctx, { botId: req.query.botId || undefined, status: statuses.length ? statuses : undefined });
  });

  app.post('/api/tasks', async (req) => {
    const body = z
      .object({ botId: z.string().uuid(), title: z.string().min(1).max(300), details: z.string().max(4000).optional(), dueAt: z.string().nullable().optional() })
      .parse(req.body);
    return createTask(ctx, body);
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const body = z
      .object({ title: z.string().min(1).max(300).optional(), details: z.string().max(4000).optional(), status: taskStatus.optional(), dueAt: z.string().nullable().optional() })
      .parse(req.body);
    return updateTask(ctx, req.params.id, body);
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    await deleteTask(ctx, req.params.id);
    return { ok: true };
  });

  app.get<{ Querystring: { botId?: string; limit?: string } }>('/api/nudges', async (req) =>
    listNudges(ctx, { botId: req.query.botId || undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }),
  );

  app.patch<{ Params: { id: string } }>('/api/nudges/:id', async (req) => {
    const { status } = z.object({ status: z.enum(['dismissed', 'acted']) }).parse(req.body);
    return setNudgeStatus(ctx, req.params.id, status);
  });
}
