import { z } from 'zod';
import { COMPLETION_PUSH_MODES } from './api';
import { COMPUTE_MODES, DEFAULT_THRESHOLDS } from './quota';
import { DEFAULT_SENSITIVE_DOMAINS } from './risk';
import { isValidHHMM, isValidTimeZone } from './time';

const hhmm = z.string().refine(isValidHHMM, 'Format attendu : HH:MM');
const pct = z.number().min(1).max(100);

export const timeRangeSchema = z.object({ start: hhmm, end: hhmm });

const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Date ISO attendue');

/** State of the « Tout arrêter » emergency stop while it is engaged (written by POST /api/system/emergency-stop). */
export const emergencyStopSchema = z.object({
  at: isoDate,
  reason: z.string().max(500).nullable(),
  /** Bots this stop paused (the resume re-enables only these, not the ones the owner had paused himself). */
  pausedBotIds: z.array(z.string().uuid()),
  cancelledRuns: z.number().int().min(0),
  rejectedApprovals: z.number().int().min(0),
});
export type EmergencyStopState = z.infer<typeof emergencyStopSchema>;

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
  /** Push « <bot> a terminé » when a run ends while the owner is not looking (bots and routines may override). */
  completionPush: z.enum(COMPLETION_PUSH_MODES),
  /** With `completionPush: 'long'`: only runs that lasted at least this long. */
  completionPushMinSeconds: z.number().int().min(10).max(3600),
  /** notify_owner calls allowed per bot and per local day. */
  notifyOwnerDailyLimit: z.number().int().min(0).max(50),
  /**
   * Spending cap of one run on the subscription, in API-equivalent dollars (passed as maxBudgetUsd); 0 = no cap.
   * Protects the shared 5-hour window from a runaway loop.
   */
  perRunSubscriptionCapUsd: z.number().min(0).max(1_000),
  /** Server-managed (emergency-stop / emergency-resume endpoints): not accepted by PATCH /api/settings. */
  emergencyStop: emergencyStopSchema.nullable(),
  /** Server-managed: domain grants decided before this instant no longer count (emergency stop, « Tout révoquer »). */
  grantsRevokedAt: isoDate.nullable(),
  /** End of the first-run guide (/bienvenue); null = not done. Set back to null to replay it. */
  onboardingDoneAt: isoDate.nullable(),
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
  completionPush: 'long',
  completionPushMinSeconds: 45,
  notifyOwnerDailyLimit: 5,
  perRunSubscriptionCapUsd: 5,
  emergencyStop: null,
  grantsRevokedAt: null,
  onboardingDoneAt: null,
};

/** Keys only the server writes (dedicated endpoints): PATCH /api/settings drops them. */
export const SERVER_MANAGED_SETTINGS = ['emergencyStop', 'grantsRevokedAt'] as const;

/** What the owner may send to PATCH /api/settings. */
export const settingsPatchSchema = appSettingsSchema.omit({ emergencyStop: true, grantsRevokedAt: true }).partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Validates a merged settings object, checking cross-field constraints. Server code may also pass server-managed keys. */
export function mergeSettings(current: AppSettings, patch: SettingsPatch | Partial<AppSettings>): AppSettings {
  const merged = appSettingsSchema.parse({ ...current, ...patch });
  const t = merged.thresholds;
  if (t.reserveFiveHour > t.hardFiveHour) throw new Error('Le seuil de réserve 5 h doit être inférieur ou égal au seuil maximal.');
  if (t.reserveWeekly > t.hardWeekly) throw new Error('Le seuil de réserve hebdomadaire doit être inférieur ou égal au seuil maximal.');
  if (merged.apiDailyCapUsd > merged.apiMonthlyCapUsd) throw new Error('Le plafond quotidien ne peut pas dépasser le plafond mensuel.');
  return merged;
}
