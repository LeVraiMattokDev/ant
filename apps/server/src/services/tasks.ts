import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { TaskAssignee, TaskDTO, TaskStatus } from '@ant/shared';
import { tasks } from '../db/schema';
import { taskToDTO } from '../lib/dto';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import { assertActiveBot } from './bots';
import type { Ctx } from './context';

const STATUSES: TaskStatus[] = ['open', 'waiting', 'done', 'dropped'];

export interface TaskInput {
  botId: string;
  title: string;
  details?: string;
  status?: TaskStatus;
  dueAt?: string | null;
  sourceMessageId?: string | null;
  /** Default `bot`. */
  assignee?: TaskAssignee;
}

function parseDue(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid_date', 'Date d’échéance invalide.');
  return d;
}

export async function listTasks(ctx: Ctx, filter: { botId?: string; status?: TaskStatus[] } = {}): Promise<TaskDTO[]> {
  const conditions = [];
  if (filter.botId) conditions.push(eq(tasks.botId, filter.botId));
  if (filter.status?.length) conditions.push(inArray(tasks.status, filter.status));
  const rows = await ctx.db
    .select()
    .from(tasks)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(tasks.status), asc(tasks.dueAt), desc(tasks.updatedAt))
    .limit(500);
  return rows.map(taskToDTO);
}

export async function createTask(ctx: Ctx, input: TaskInput): Promise<TaskDTO> {
  if (!input.title.trim()) throw new HttpError(400, 'invalid_title', 'Titre obligatoire.');
  if (input.status && !STATUSES.includes(input.status)) throw new HttpError(400, 'invalid_status', 'Statut invalide.');
  const dueAt = parseDue(input.dueAt) ?? null;
  await assertActiveBot(ctx, input.botId);
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      botId: input.botId,
      title: input.title.trim().slice(0, 300),
      details: input.details ?? '',
      status: input.status ?? 'open',
      assignee: input.assignee ?? 'bot',
      dueAt,
      sourceMessageId: input.sourceMessageId ?? null,
    })
    .returning();
  await publish(ctx.sql, { type: 'tasks.updated' });
  return taskToDTO(row!);
}

export async function updateTask(ctx: Ctx, id: string, patch: Partial<Omit<TaskInput, 'botId'>>, botId?: string): Promise<TaskDTO> {
  const current = await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!current) throw new HttpError(404, 'not_found', 'Tâche introuvable.');
  if (botId && current.botId !== botId) throw new HttpError(403, 'forbidden', 'Cette tâche appartient à un autre bot.');
  if (patch.status && !STATUSES.includes(patch.status)) throw new HttpError(400, 'invalid_status', 'Statut invalide.');
  const due = parseDue(patch.dueAt);
  const [row] = await ctx.db
    .update(tasks)
    .set({
      title: patch.title?.trim() || current.title,
      details: patch.details ?? current.details,
      status: patch.status ?? current.status,
      dueAt: due === undefined ? current.dueAt : due,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();
  await publish(ctx.sql, { type: 'tasks.updated' });
  return taskToDTO(row!);
}

export async function deleteTask(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.delete(tasks).where(eq(tasks.id, id));
  await publish(ctx.sql, { type: 'tasks.updated' });
}

export async function openTasksSummary(ctx: Ctx, botId: string, limit = 30): Promise<string> {
  const rows = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.botId, botId), inArray(tasks.status, ['open', 'waiting'])))
    .orderBy(asc(tasks.dueAt), desc(tasks.updatedAt))
    .limit(limit);
  if (rows.length === 0) return '(aucune tâche ouverte)';
  return rows
    .map((t) => `- [${t.status === 'open' ? 'ouverte' : 'en attente'}] ${t.title}${t.dueAt ? ` (échéance ${t.dueAt.toISOString().slice(0, 10)})` : ''} — id ${t.id}${t.details ? ` : ${t.details.slice(0, 200)}` : ''}`)
    .join('\n');
}
