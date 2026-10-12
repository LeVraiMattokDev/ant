import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { CronExpressionParser } from 'cron-parser';
import { describeCron, isValidTimeZone, type RoutineDTO, type RoutineInput } from '@ant/shared';
import { channels, routines } from '../db/schema';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import { dmChannelId } from './bots';
import type { Ctx } from './context';

export type RoutineRow = typeof routines.$inferSelect;

const FIELD_RE = /^[\d*,/\-]+$/;

/** Accepts standard 5-field cron expressions only (no seconds, no macros). */
export function validateCron(expr: string, timezone: string): string {
  const cleaned = expr.trim().replace(/\s+/g, ' ');
  const fields = cleaned.split(' ');
  if (fields.length !== 5 || !fields.every((f) => FIELD_RE.test(f))) {
    throw new HttpError(400, 'invalid_cron', 'Expression cron invalide (5 champs attendus : minute heure jour mois jour-de-semaine).');
  }
  if (!isValidTimeZone(timezone)) throw new HttpError(400, 'invalid_timezone', 'Fuseau horaire inconnu.');
  try {
    CronExpressionParser.parse(cleaned, { tz: timezone }).next();
  } catch {
    throw new HttpError(400, 'invalid_cron', 'Expression cron invalide.');
  }
  // Refuse schedules more frequent than every 15 minutes.
  const it = CronExpressionParser.parse(cleaned, { tz: timezone });
  const a = it.next().toDate().getTime();
  const b = it.next().toDate().getTime();
  if (b - a < 15 * 60_000) throw new HttpError(400, 'too_frequent', 'Une routine ne peut pas s’exécuter plus d’une fois toutes les 15 minutes.');
  return cleaned;
}

export function nextRuns(cron: string, timezone: string, count = 3, from = new Date()): Date[] {
  const it = CronExpressionParser.parse(cron, { tz: timezone, currentDate: from });
  const out: Date[] = [];
  for (let i = 0; i < count; i++) out.push(it.next().toDate());
  return out;
}

export function routineToDTO(row: RoutineRow): RoutineDTO {
  return {
    id: row.id,
    botId: row.botId,
    channelId: row.channelId,
    sourceText: row.sourceText,
    cron: row.cron,
    timezone: row.timezone,
    description: describeCron(row.cron),
    instruction: row.instruction,
    urgent: row.urgent,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRuns: row.enabled ? nextRuns(row.cron, row.timezone).map((d) => d.toISOString()) : [],
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRoutines(ctx: Ctx): Promise<RoutineDTO[]> {
  const rows = await ctx.db.select().from(routines).orderBy(asc(routines.createdAt));
  return rows.map(routineToDTO);
}

export async function createRoutine(ctx: Ctx, input: RoutineInput, defaultTimezone: string): Promise<RoutineDTO> {
  const timezone = input.timezone ?? defaultTimezone;
  const cron = validateCron(input.cron, timezone);
  if (!input.instruction.trim()) throw new HttpError(400, 'invalid_instruction', 'La consigne est obligatoire.');
  const channelId = input.channelId ?? (await dmChannelId(ctx, input.botId));
  const channel = await ctx.db.query.channels.findFirst({ where: eq(channels.id, channelId) });
  if (!channel) throw new HttpError(400, 'invalid_channel', 'Canal introuvable.');
  const enabled = input.enabled ?? true;
  const [row] = await ctx.db
    .insert(routines)
    .values({
      botId: input.botId,
      channelId,
      sourceText: input.sourceText.trim() || input.instruction.trim(),
      cron,
      timezone,
      instruction: input.instruction.trim(),
      urgent: input.urgent ?? false,
      enabled,
      nextRunAt: enabled ? nextRuns(cron, timezone, 1)[0]! : null,
    })
    .returning();
  await publish(ctx.sql, { type: 'routines.updated' });
  return routineToDTO(row!);
}

export async function updateRoutine(ctx: Ctx, id: string, patch: Partial<RoutineInput>): Promise<RoutineDTO> {
  const current = await ctx.db.query.routines.findFirst({ where: eq(routines.id, id) });
  if (!current) throw new HttpError(404, 'not_found', 'Routine introuvable.');
  const timezone = patch.timezone ?? current.timezone;
  const cron = patch.cron !== undefined || patch.timezone !== undefined ? validateCron(patch.cron ?? current.cron, timezone) : current.cron;
  const enabled = patch.enabled ?? current.enabled;
  const [row] = await ctx.db
    .update(routines)
    .set({
      cron,
      timezone,
      instruction: patch.instruction?.trim() || current.instruction,
      sourceText: patch.sourceText?.trim() || current.sourceText,
      urgent: patch.urgent ?? current.urgent,
      enabled,
      botId: patch.botId ?? current.botId,
      channelId: patch.channelId ?? current.channelId,
      nextRunAt: enabled ? nextRuns(cron, timezone, 1)[0]! : null,
      updatedAt: new Date(),
    })
    .where(eq(routines.id, id))
    .returning();
  await publish(ctx.sql, { type: 'routines.updated' });
  return routineToDTO(row!);
}

export async function deleteRoutine(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.delete(routines).where(eq(routines.id, id));
  await publish(ctx.sql, { type: 'routines.updated' });
}

export async function dueRoutines(ctx: Ctx, now = new Date()): Promise<RoutineRow[]> {
  return ctx.db
    .select()
    .from(routines)
    .where(and(eq(routines.enabled, true), isNotNull(routines.nextRunAt), lte(routines.nextRunAt, now)));
}

/** Marks a routine as fired and computes its next occurrence. */
export async function advanceRoutine(ctx: Ctx, row: RoutineRow, now = new Date()): Promise<void> {
  await ctx.db
    .update(routines)
    .set({ lastRunAt: now, nextRunAt: nextRuns(row.cron, row.timezone, 1, now)[0]!, updatedAt: now })
    .where(eq(routines.id, row.id));
  await publish(ctx.sql, { type: 'routines.updated' });
}
