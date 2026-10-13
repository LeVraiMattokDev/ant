import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { CronExpressionParser } from 'cron-parser';
import { describeCron, isValidTimeZone, type RoutineDTO, type RoutineInput } from '@ant/shared';
import { bots, channelMembers, channels, routines } from '../db/schema';
import { HttpError } from '../lib/errors';
import { publish } from '../lib/events';
import { dmChannelId } from './bots';
import type { Ctx } from './context';

export type RoutineRow = typeof routines.$inferSelect;

const FIELD_RE = /^[\d*,/\-]+$/;
const MIN_GAP_MINUTES = 15;

/**
 * Smallest possible gap, in minutes, between two consecutive occurrences, whatever the current time:
 * every matching day fires on the same hour × minute grid, so it is the smallest gap inside that grid,
 * or the wrap-around from the day's last time to the next matching day's first time (counted as if
 * matching days could follow each other, which errs on the safe side).
 */
export function minGapMinutes(cron: string, timezone: string): number {
  const { fields } = CronExpressionParser.parse(cron, { tz: timezone });
  const times: number[] = [];
  for (const h of fields.hour.values) for (const m of fields.minute.values) times.push(Number(h) * 60 + Number(m));
  times.sort((x, y) => x - y);
  let gap = times[0]! + 1440 - times[times.length - 1]!;
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i]! - times[i - 1]!);
  return gap;
}

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
  if (minGapMinutes(cleaned, timezone) < MIN_GAP_MINUTES) {
    throw new HttpError(400, 'too_frequent', 'Une routine ne peut pas s’exécuter plus d’une fois toutes les 15 minutes.');
  }
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

async function assertActiveBot(ctx: Ctx, botId: string): Promise<void> {
  const bot = await ctx.db.query.bots.findFirst({ columns: { id: true }, where: and(eq(bots.id, botId), isNull(bots.archivedAt)) });
  if (!bot) throw new HttpError(400, 'unknown_bot', 'Bot introuvable ou archivé.');
}

/** Why `channelId` cannot receive this bot's routine, or null when it can. */
async function targetProblem(ctx: Ctx, botId: string, channelId: string): Promise<string | null> {
  const channel = await ctx.db.query.channels.findFirst({ where: eq(channels.id, channelId) });
  if (!channel || channel.archivedAt) return 'Canal introuvable ou archivé.';
  if (channel.kind === 'dm') return channel.dmBotId === botId ? null : 'Ce canal privé appartient à un autre bot.';
  const member = await ctx.db.query.channelMembers.findFirst({ where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.botId, botId)) });
  return member ? null : 'Le bot n’est pas membre de ce canal.';
}

/**
 * Whether a routine of `botId` may post in `channelId`: its own private conversation, or an active group
 * it belongs to. A bot that proposes a routine from a conversation it cannot post routines in (another
 * bot's private conversation, where a handoff runs it) proposes it in its own instead (`channelId: null`).
 */
export async function canPostRoutine(ctx: Ctx, botId: string, channelId: string): Promise<boolean> {
  return (await targetProblem(ctx, botId, channelId)) === null;
}

/** The channel a routine of `botId` posts in: `channelId`, or the bot's private conversation when null. */
async function resolveTarget(ctx: Ctx, botId: string, channelId: string | null | undefined): Promise<string> {
  await assertActiveBot(ctx, botId);
  const id = channelId ?? (await dmChannelId(ctx, botId));
  const problem = await targetProblem(ctx, botId, id);
  if (problem) throw new HttpError(400, 'invalid_channel', problem);
  return id;
}

export async function createRoutine(ctx: Ctx, input: RoutineInput, defaultTimezone: string): Promise<RoutineDTO> {
  const timezone = input.timezone ?? defaultTimezone;
  const cron = validateCron(input.cron, timezone);
  if (!input.instruction.trim()) throw new HttpError(400, 'invalid_instruction', 'La consigne est obligatoire.');
  const channelId = await resolveTarget(ctx, input.botId, input.channelId);
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

/**
 * - `channelId: null` moves the routine to its bot's private conversation.
 * - A new bot without a `channelId` keeps the current channel when the new bot may post there, else takes its DM.
 * - Enabling a routine checks its schedule and target again (a routine proposed by a bot was created disabled).
 */
export async function updateRoutine(ctx: Ctx, id: string, patch: Partial<RoutineInput>): Promise<RoutineDTO> {
  const current = await ctx.db.query.routines.findFirst({ where: eq(routines.id, id) });
  if (!current) throw new HttpError(404, 'not_found', 'Routine introuvable.');
  const timezone = patch.timezone ?? current.timezone;
  const enabled = patch.enabled ?? current.enabled;
  const enabling = enabled && !current.enabled;
  const cron = patch.cron !== undefined || patch.timezone !== undefined || enabling ? validateCron(patch.cron ?? current.cron, timezone) : current.cron;
  const botId = patch.botId ?? current.botId;
  const botChanged = botId !== current.botId;
  let channelId = current.channelId;
  if (patch.channelId !== undefined) {
    channelId = await resolveTarget(ctx, botId, patch.channelId);
  } else if (botChanged) {
    await assertActiveBot(ctx, botId);
    channelId = (await targetProblem(ctx, botId, current.channelId)) ? await resolveTarget(ctx, botId, null) : current.channelId;
  } else if (enabling) {
    channelId = await resolveTarget(ctx, botId, current.channelId);
  }
  const [row] = await ctx.db
    .update(routines)
    .set({
      cron,
      timezone,
      instruction: patch.instruction?.trim() || current.instruction,
      sourceText: patch.sourceText?.trim() || current.sourceText,
      urgent: patch.urgent ?? current.urgent,
      enabled,
      botId,
      channelId,
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

/**
 * Claims one occurrence of a due routine: marks it fired and computes its next occurrence. Atomic, so
 * overlapping scheduler passes cannot both fire the same occurrence. Returns false when another pass
 * already advanced it, or when it was disabled in the meantime.
 */
export async function advanceRoutine(ctx: Ctx, row: RoutineRow, now = new Date()): Promise<boolean> {
  const claimed = await ctx.db
    .update(routines)
    .set({ lastRunAt: now, nextRunAt: nextRuns(row.cron, row.timezone, 1, now)[0]!, updatedAt: now })
    .where(and(eq(routines.id, row.id), eq(routines.enabled, true), lte(routines.nextRunAt, now)))
    .returning({ id: routines.id });
  if (claimed.length === 0) return false;
  await publish(ctx.sql, { type: 'routines.updated' });
  return true;
}

/** Agent session key of a routine: each routine keeps its own session instead of resuming its channel's. */
export function routineThreadKey(routineId: string): string {
  return `routine:${routineId}`;
}
