import { z } from 'zod';
import { COMPUTE_MODES, DEFAULT_THRESHOLDS } from './quota';
import { DEFAULT_SENSITIVE_DOMAINS } from './risk';
import { isValidHHMM, isValidTimeZone } from './time';

const hhmm = z.string().refine(isValidHHMM, 'Format attendu : HH:MM');
const pct = z.number().min(1).max(100);

export const timeRangeSchema = z.object({ start: hhmm, end: hhmm });

export const appSettingsSchema = z.object({
  computeMode: z.enum(COMPUTE_MODES),
  thresholds: z.object({
    reserveFiveHour: pct,
    reserveWeekly: pct,
    hardFiveHour: pct,
    hardWeekly: pct,
  }),
  apiDailyCapUsd: z.number().min(0).max(10_000),
  apiMonthlyCapUsd: z.number().min(0).max(100_000),
  perRunCapUsd: z.number().min(0.05).max(1_000),
  alertThresholds: z.array(pct).min(1).max(6),
  timezone: z.string().refine(isValidTimeZone, 'Fuseau horaire inconnu'),
  quietHours: timeRangeSchema.nullable(),
  /** Urgent approvals still trigger a push during quiet hours. */
  urgentPushDuringQuietHours: z.boolean(),
  digestEnabled: z.boolean(),
  digestTime: hhmm,
  /** Bot that writes the daily digest; null = first bot. */
  digestBotId: z.string().uuid().nullable(),
  maxConcurrentRuns: z.number().int().min(1).max(10),
  maxHandoffHops: z.number().int().min(1).max(30),
  expertDailyLimit: z.number().int().min(0).max(100),
  /** Above this estimated size an agent session is summarised and rotated. */
  sessionRotateTokens: z.number().int().min(20_000).max(900_000),
  sensitiveDomains: z.array(z.string().min(1).max(253)).max(500),
  approvalExpiryHours: z.number().int().min(1).max(24 * 30),
  /** ISO date the subscription token was created with `claude setup-token` (for expiry reminders). */
  subscriptionTokenCreatedAt: z.string().nullable(),
  /** Days without reaction before an ignored nudge topic may come back. */
  nudgeCooldownDays: z.number().int().min(1).max(90),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  computeMode: 'hybrid_safe',
  thresholds: { ...DEFAULT_THRESHOLDS },
  apiDailyCapUsd: 8,
  apiMonthlyCapUsd: 100,
  perRunCapUsd: 2,
  alertThresholds: [50, 80, 95],
  timezone: 'Europe/Zurich',
  quietHours: { start: '22:00', end: '07:30' },
  urgentPushDuringQuietHours: true,
  digestEnabled: true,
  digestTime: '07:45',
  digestBotId: null,
  maxConcurrentRuns: 3,
  maxHandoffHops: 8,
  expertDailyLimit: 5,
  sessionRotateTokens: 150_000,
  sensitiveDomains: [...DEFAULT_SENSITIVE_DOMAINS],
  approvalExpiryHours: 72,
  subscriptionTokenCreatedAt: null,
  nudgeCooldownDays: 14,
};

export const settingsPatchSchema = appSettingsSchema.partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Validates a merged settings object, checking cross-field constraints. */
export function mergeSettings(current: AppSettings, patch: SettingsPatch): AppSettings {
  const merged = appSettingsSchema.parse({ ...current, ...patch });
  const t = merged.thresholds;
  if (t.reserveFiveHour > t.hardFiveHour) throw new Error('Le seuil de réserve 5 h doit être inférieur ou égal au seuil maximal.');
  if (t.reserveWeekly > t.hardWeekly) throw new Error('Le seuil de réserve hebdomadaire doit être inférieur ou égal au seuil maximal.');
  if (merged.apiDailyCapUsd > merged.apiMonthlyCapUsd) throw new Error('Le plafond quotidien ne peut pas dépasser le plafond mensuel.');
  return merged;
}
