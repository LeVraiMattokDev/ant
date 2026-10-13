import { and, eq, gte, lte, sql as dsql } from 'drizzle-orm';
import {
  WORKER_ALIVE_MS,
  apiRemainingUsd,
  localDateKey,
  localMonthKey,
  localParts,
  normaliseUtilisation,
  round2,
  type AppSettings,
  type ComputeSource,
  type QuotaStatusDTO,
  type SubscriptionHealth,
  type UsagePurpose,
  type UsageRowDTO,
} from '@ant/shared';
import { computeState, runModelUsage, subscriptionEvents } from '../db/schema';
import { publish } from '../lib/events';
import type { Ctx } from './context';
import { getServiceStatus } from './service-status';

export type ComputeStateRow = typeof computeState.$inferSelect;

export async function getComputeState(ctx: Ctx): Promise<ComputeStateRow> {
  const row = await ctx.db.query.computeState.findFirst({ where: eq(computeState.id, 1) });
  if (row) return row;
  const [created] = await ctx.db.insert(computeState).values({ id: 1 }).onConflictDoNothing().returning();
  return created ?? (await ctx.db.query.computeState.findFirst({ where: eq(computeState.id, 1) }))!;
}

export async function patchComputeState(ctx: Ctx, patch: Partial<typeof computeState.$inferInsert>): Promise<ComputeStateRow> {
  await getComputeState(ctx);
  const [row] = await ctx.db
    .update(computeState)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(computeState.id, 1))
    .returning();
  await publish(ctx.sql, { type: 'quota.updated' });
  return row!;
}

/** Shape of `rate_limit_info` in the Agent SDK's `rate_limit_event` (only the fields Ant uses). */
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  [key: string]: unknown;
}

/** `resetsAt` is a Unix timestamp; the docs do not state the unit, so seconds and milliseconds are both accepted. */
export function resetsAtToDate(value: number | undefined): Date | null {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value < 1e12 ? value * 1000 : value);
}

export interface RateLimitOutcome {
  limited: boolean;
  limitedUntil: Date | null;
  state: ComputeStateRow;
}

export async function recordRateLimitEvent(ctx: Ctx, info: RateLimitInfo, now = new Date()): Promise<RateLimitOutcome> {
  const resetsAt = resetsAtToDate(info.resetsAt);
  const util = normaliseUtilisation(info.utilization);
  await ctx.db.insert(subscriptionEvents).values({
    status: info.status,
    limitType: info.rateLimitType ?? null,
    utilization: util,
    resetsAt,
    raw: info,
  });
  const patch: Partial<typeof computeState.$inferInsert> = { subLastStatus: info.status, subLastEventAt: now, subAuthFailed: false };
  const type = info.rateLimitType ?? '';
  if (type === 'five_hour') {
    if (util !== null) patch.subFiveHourUtil = util;
    if (resetsAt) patch.subFiveHourResetsAt = resetsAt;
  } else if (type.startsWith('seven_day')) {
    if (util !== null) patch.subSevenDayUtil = util;
    if (resetsAt) patch.subSevenDayResetsAt = resetsAt;
  }
  let limitedUntil: Date | null = null;
  if (info.status === 'rejected') {
    limitedUntil = resetsAt ?? new Date(now.getTime() + 60 * 60_000);
    patch.subLimitedUntil = limitedUntil;
    if (type === 'five_hour') patch.subFiveHourUtil = 100;
    if (type.startsWith('seven_day')) patch.subSevenDayUtil = 100;
  }
  const state = await patchComputeState(ctx, patch);
  return { limited: info.status === 'rejected', limitedUntil, state };
}

/** Called when the subscription refused a request without a usable rate_limit_event. */
export async function markSubscriptionLimited(ctx: Ctx, until: Date): Promise<ComputeStateRow> {
  return patchComputeState(ctx, { subLimitedUntil: until, subLastStatus: 'rejected', subLastEventAt: new Date() });
}

/** Zeroes the figures of the usage windows whose reset time has passed (they describe a finished window). */
function expiredWindowPatch(state: ComputeStateRow, now: number): Partial<typeof computeState.$inferInsert> {
  const patch: Partial<typeof computeState.$inferInsert> = {};
  if (state.subFiveHourResetsAt && state.subFiveHourResetsAt.getTime() <= now) {
    patch.subFiveHourUtil = 0;
    patch.subFiveHourResetsAt = null;
  }
  if (state.subSevenDayResetsAt && state.subSevenDayResetsAt.getTime() <= now) {
    patch.subSevenDayUtil = 0;
    patch.subSevenDayResetsAt = null;
  }
  return patch;
}

export async function clearSubscriptionLimit(ctx: Ctx, now = new Date()): Promise<ComputeStateRow> {
  const state = await getComputeState(ctx);
  return patchComputeState(ctx, { subLimitedUntil: null, subLastStatus: 'allowed', ...expiredWindowPatch(state, now.getTime()) });
}

/**
 * Lifts the subscription limit once its end has passed. Atomic: when two scheduler passes overlap,
 * only one gets `true` (and announces the restoration). Returns false when no limit had expired.
 */
export async function liftExpiredSubscriptionLimit(ctx: Ctx, now = new Date()): Promise<boolean> {
  const state = await getComputeState(ctx);
  const [row] = await ctx.db
    .update(computeState)
    .set({ subLimitedUntil: null, subLastStatus: 'allowed', ...expiredWindowPatch(state, now.getTime()), updatedAt: new Date() })
    .where(and(eq(computeState.id, 1), lte(computeState.subLimitedUntil, now)))
    .returning({ id: computeState.id });
  if (!row) return false;
  await publish(ctx.sql, { type: 'quota.updated' });
  return true;
}

/**
 * A usage window has reset: zero its stale figures, but keep a limit that is still running
 * (a weekly rejection outlives the reset of the 5-hour window, and vice versa).
 */
export async function expireUsageWindows(ctx: Ctx, now = new Date()): Promise<ComputeStateRow> {
  const state = await getComputeState(ctx);
  const patch = expiredWindowPatch(state, now.getTime());
  return Object.keys(patch).length > 0 ? patchComputeState(ctx, patch) : state;
}

/** Utilisation figures are stale once their window has reset. */
export function effectiveUtilisation(state: ComputeStateRow, now = new Date()): { fiveHour: number | null; sevenDay: number | null } {
  const five = state.subFiveHourResetsAt && state.subFiveHourResetsAt.getTime() <= now.getTime() ? null : state.subFiveHourUtil;
  const seven = state.subSevenDayResetsAt && state.subSevenDayResetsAt.getTime() <= now.getTime() ? null : state.subSevenDayUtil;
  return { fiveHour: five ?? null, sevenDay: seven ?? null };
}

export interface UsageRecord {
  runId: string | null;
  botId: string | null;
  /** What the call was for: the run's trigger, or the one-shot's purpose. */
  purpose?: UsagePurpose | null;
  routineId?: string | null;
  source: ComputeSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Totals of usage records: what a run adds to its own counters (cost, tokens). */
export function sumUsage(usage: readonly UsageRecord[]): Pick<UsageRecord, 'costUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> {
  const sum = (k: 'costUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => usage.reduce((acc, u) => acc + (Number(u[k]) || 0), 0);
  return {
    costUsd: sum('costUsd'),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordUsage(ctx: Ctx, records: UsageRecord[], timezone: string, now = new Date()): Promise<void> {
  const rows = records.filter((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens > 0 || r.costUsd > 0);
  if (rows.length === 0) return;
  await ctx.db.insert(runModelUsage).values(
    rows.map((r) => ({
      runId: r.runId,
      botId: r.botId,
      purpose: r.purpose ?? null,
      // A malformed id would make the whole insert fail, and the spend would be counted nowhere.
      routineId: r.routineId && UUID_RE.test(r.routineId) ? r.routineId : null,
      day: localDateKey(now, timezone),
      month: localMonthKey(now, timezone),
      model: r.model,
      computeSource: r.source,
      inputTokens: Math.round(r.inputTokens),
      outputTokens: Math.round(r.outputTokens),
      cacheReadTokens: Math.round(r.cacheReadTokens),
      cacheWriteTokens: Math.round(r.cacheWriteTokens),
      costUsd: r.costUsd,
    })),
  );
  await publish(ctx.sql, { type: 'quota.updated' });
}

export interface ApiSpend {
  todayUsd: number;
  monthUsd: number;
  botTodayUsd: number;
}

export async function apiSpend(ctx: Ctx, timezone: string, botId?: string | null, now = new Date()): Promise<ApiSpend> {
  const day = localDateKey(now, timezone);
  const month = localMonthKey(now, timezone);
  const [row] = await ctx.db
    .select({
      today: dsql<number>`coalesce(sum(case when ${runModelUsage.day} = ${day} then ${runModelUsage.costUsd} else 0 end), 0)::float`,
      month: dsql<number>`coalesce(sum(${runModelUsage.costUsd}), 0)::float`,
      botToday: botId
        ? dsql<number>`coalesce(sum(case when ${runModelUsage.day} = ${day} and ${runModelUsage.botId} = ${botId} then ${runModelUsage.costUsd} else 0 end), 0)::float`
        : dsql<number>`0::float`,
    })
    .from(runModelUsage)
    .where(and(eq(runModelUsage.computeSource, 'api'), eq(runModelUsage.month, month)));
  return { todayUsd: round2(row?.today ?? 0), monthUsd: round2(row?.month ?? 0), botTodayUsd: round2(row?.botToday ?? 0) };
}

export async function subscriptionUsageToday(ctx: Ctx, timezone: string, now = new Date()): Promise<{ tokens: number; equivalentUsd: number }> {
  const day = localDateKey(now, timezone);
  const [row] = await ctx.db
    .select({
      tokens: dsql<number>`coalesce(sum(${runModelUsage.inputTokens} + ${runModelUsage.outputTokens} + ${runModelUsage.cacheReadTokens} + ${runModelUsage.cacheWriteTokens}), 0)::bigint`,
      cost: dsql<number>`coalesce(sum(${runModelUsage.costUsd}), 0)::float`,
    })
    .from(runModelUsage)
    .where(and(eq(runModelUsage.computeSource, 'subscription'), eq(runModelUsage.day, day)));
  return { tokens: Number(row?.tokens ?? 0), equivalentUsd: round2(row?.cost ?? 0) };
}

export async function usageRows(ctx: Ctx, days: number, timezone: string, now = new Date()): Promise<UsageRowDTO[]> {
  const since = localDateKey(new Date(now.getTime() - (days - 1) * 86_400_000), timezone);
  const rows = await ctx.db
    .select({
      day: runModelUsage.day,
      botId: runModelUsage.botId,
      model: runModelUsage.model,
      computeSource: runModelUsage.computeSource,
      inputTokens: dsql<number>`sum(${runModelUsage.inputTokens})::int`,
      outputTokens: dsql<number>`sum(${runModelUsage.outputTokens})::int`,
      cacheReadTokens: dsql<number>`sum(${runModelUsage.cacheReadTokens})::int`,
      cacheWriteTokens: dsql<number>`sum(${runModelUsage.cacheWriteTokens})::int`,
      costUsd: dsql<number>`sum(${runModelUsage.costUsd})::float`,
      runs: dsql<number>`count(distinct ${runModelUsage.runId})::int`,
    })
    .from(runModelUsage)
    .where(gte(runModelUsage.day, since))
    .groupBy(runModelUsage.day, runModelUsage.botId, runModelUsage.model, runModelUsage.computeSource)
    .orderBy(runModelUsage.day);
  return rows.map((r) => ({ ...r, costUsd: round2(r.costUsd) }));
}

export function subscriptionHealth(state: ComputeStateRow, settings: AppSettings, now = new Date()): SubscriptionHealth {
  if (!state.subConfigured) return 'not_configured';
  if (state.subAuthFailed) return 'auth_failed';
  if (state.subLimitedUntil && state.subLimitedUntil.getTime() > now.getTime()) return 'limited';
  const util = effectiveUtilisation(state, now);
  if (util.fiveHour === null && util.sevenDay === null) return state.subLastEventAt ? 'ok' : 'unknown';
  if ((util.fiveHour ?? 0) >= settings.thresholds.reserveFiveHour || (util.sevenDay ?? 0) >= settings.thresholds.reserveWeekly) return 'warning';
  return 'ok';
}

/**
 * Elapsed days counted at least by the monthly projection: one $2 run at 01:00 on the 1st must not project
 * $1,500 (and use up the month's single projection alert). Until then the projection is « spent ÷ 3 × days ».
 */
export const FORECAST_MIN_ELAPSED_DAYS = 3;

/** Linear projection of the month's API spend (local calendar month of `timezone`). */
export function forecastMonthUsd(spentMonthUsd: number, timezone: string, now = new Date()): number {
  const p = localParts(now, timezone);
  const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  // Elapsed fraction of the month, counting the current day pro rata.
  const elapsedDays = Math.max(p.day - 1 + (p.hour * 60 + p.minute) / 1440, FORECAST_MIN_ELAPSED_DAYS);
  return round2((spentMonthUsd / elapsedDays) * daysInMonth);
}

export async function quotaStatus(ctx: Ctx, settings: AppSettings, now = new Date()): Promise<QuotaStatusDTO> {
  const state = await getComputeState(ctx);
  const worker = await getServiceStatus(ctx, 'worker');
  const spend = await apiSpend(ctx, settings.timezone, null, now);
  const sub = await subscriptionUsageToday(ctx, settings.timezone, now);
  const util = effectiveUtilisation(state, now);
  const tokenCreatedAt = settings.subscriptionTokenCreatedAt ? new Date(settings.subscriptionTokenCreatedAt) : null;
  const tokenExpiresAt = tokenCreatedAt ? new Date(tokenCreatedAt.getTime() + 365 * 86_400_000) : null;
  return {
    mode: settings.computeMode,
    thresholds: settings.thresholds,
    subscription: {
      configured: state.subConfigured,
      health: subscriptionHealth(state, settings, now),
      limitedUntil: state.subLimitedUntil && state.subLimitedUntil.getTime() > now.getTime() ? state.subLimitedUntil.toISOString() : null,
      fiveHour: { utilization: util.fiveHour, resetsAt: state.subFiveHourResetsAt?.toISOString() ?? null },
      sevenDay: { utilization: util.sevenDay, resetsAt: state.subSevenDayResetsAt?.toISOString() ?? null },
      lastEventAt: state.subLastEventAt?.toISOString() ?? null,
      tokenCreatedAt: tokenCreatedAt?.toISOString() ?? null,
      tokenExpiresAt: tokenExpiresAt?.toISOString() ?? null,
      antTokensToday: sub.tokens,
      antEquivalentUsdToday: sub.equivalentUsd,
    },
    api: {
      configured: state.apiConfigured,
      authFailed: state.apiAuthFailed,
      spentTodayUsd: spend.todayUsd,
      spentMonthUsd: spend.monthUsd,
      dailyCapUsd: settings.apiDailyCapUsd,
      monthlyCapUsd: settings.apiMonthlyCapUsd,
      forecastMonthUsd: forecastMonthUsd(spend.monthUsd, settings.timezone, now),
    },
    allPaused: Boolean(state.allPausedReason),
    pausedReason: state.allPausedReason ?? null,
    worker: {
      lastSeenAt: worker?.seenAt.toISOString() ?? null,
      alive: worker !== null && now.getTime() - worker.seenAt.getTime() < WORKER_ALIVE_MS,
    },
  };
}

export { apiRemainingUsd };
