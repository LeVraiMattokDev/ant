import { and, eq, gte, sql as dsql } from 'drizzle-orm';
import {
  apiRemainingUsd,
  localDateKey,
  localMonthKey,
  normaliseUtilisation,
  round2,
  type AppSettings,
  type ComputeSource,
  type QuotaStatusDTO,
  type SubscriptionHealth,
  type UsageRowDTO,
} from '@ant/shared';
import { computeState, runModelUsage, subscriptionEvents } from '../db/schema';
import { publish } from '../lib/events';
import type { Ctx } from './context';

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

export async function clearSubscriptionLimit(ctx: Ctx): Promise<ComputeStateRow> {
  const state = await getComputeState(ctx);
  const now = Date.now();
  const patch: Partial<typeof computeState.$inferInsert> = { subLimitedUntil: null, subLastStatus: 'allowed' };
  if (state.subFiveHourResetsAt && state.subFiveHourResetsAt.getTime() <= now) {
    patch.subFiveHourUtil = 0;
    patch.subFiveHourResetsAt = null;
  }
  if (state.subSevenDayResetsAt && state.subSevenDayResetsAt.getTime() <= now) {
    patch.subSevenDayUtil = 0;
    patch.subSevenDayResetsAt = null;
  }
  return patchComputeState(ctx, patch);
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
  source: ComputeSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export async function recordUsage(ctx: Ctx, records: UsageRecord[], timezone: string, now = new Date()): Promise<void> {
  const rows = records.filter((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens > 0 || r.costUsd > 0);
  if (rows.length === 0) return;
  await ctx.db.insert(runModelUsage).values(
    rows.map((r) => ({
      runId: r.runId,
      botId: r.botId,
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

export async function quotaStatus(ctx: Ctx, settings: AppSettings, now = new Date()): Promise<QuotaStatusDTO> {
  const state = await getComputeState(ctx);
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
    },
    allPaused: Boolean(state.allPausedReason),
    pausedReason: state.allPausedReason ?? null,
  };
}

export { apiRemainingUsd };
