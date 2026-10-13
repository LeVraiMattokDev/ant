import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS, localDateKey, localMonthKey, type AppSettings } from '@ant/shared';
import { budgetAlerts, runModelUsage } from '../src/db/schema';
import type { PushPayload, PushSender } from '../src/services/push';
import { getComputeState, patchComputeState } from '../src/services/quota';
import { checkBudgetAlerts, clearAllPaused, reportAllPaused } from '../src/worker/alerts';
import type { WorkerDeps } from '../src/worker/deps';
import { tokenExpiryReminder } from '../src/worker/scheduler';
import { createTestDb, databaseAvailable, fakeQuery, workerDeps, type TestDb } from './helpers';

const hasDb = await databaseAvailable();
const TZ = 'Europe/Zurich';
const QUIET: AppSettings = { ...DEFAULT_SETTINGS, timezone: TZ, quietHours: { start: '22:00', end: '07:30' }, urgentPushDuringQuietHours: true };
const NO_QUIET: AppSettings = { ...QUIET, quietHours: null };
const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe.skipIf(!hasDb)('owner alerts', () => {
  let t: TestDb;
  let pushes: PushPayload[];
  let deps: WorkerDeps;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.ctx.sql`truncate run_model_usage, budget_alerts, compute_state, settings cascade`;
    await patchComputeState(t.ctx, { subConfigured: true, apiConfigured: true });
    pushes = [];
    deps = workerDeps(t.ctx, fakeQuery(async function* () {}).query);
    deps.push = {
      enabled: true,
      sendToAll: async (p: PushPayload) => {
        pushes.push(p);
        return 1;
      },
    } as unknown as PushSender;
  });

  async function spend(usd: number, at: Date): Promise<void> {
    await t.ctx.db.insert(runModelUsage).values({ day: localDateKey(at, TZ), month: localMonthKey(at, TZ), model: 'claude-sonnet-5-5', computeSource: 'api', costUsd: usd });
  }

  it('notifies a threshold once when several checks run at the same time', async () => {
    const now = new Date('2026-10-13T10:00:00Z');
    await spend(7.3, now); // 91 % of the 8 $ daily cap
    await Promise.all(Array.from({ length: 6 }, () => checkBudgetAlerts(deps, NO_QUIET, now)));
    expect(pushes.filter((p) => p.tag === 'alert-api_day')).toHaveLength(1);
    expect(pushes[0]?.title).toContain('80 %');
    const rows = await t.ctx.db.select().from(budgetAlerts).where(eq(budgetAlerts.scope, 'api_day'));
    expect(rows.map((r) => r.threshold).sort((a, b) => a - b)).toEqual([50, 80]);
  });

  it('keeps an alert reached during quiet hours for the first check after them', async () => {
    const night = new Date('2026-10-13T04:00:00Z'); // 06:00 in Zurich
    await spend(6.8, night); // 85 %
    await checkBudgetAlerts(deps, QUIET, night);
    expect(pushes).toHaveLength(0);
    expect(await t.ctx.db.select().from(budgetAlerts)).toHaveLength(0);

    const morning = new Date('2026-10-13T06:00:00Z'); // 08:00
    await checkBudgetAlerts(deps, QUIET, morning);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.title).toBe('Crédits API : 80 % du plafond du jour');
    await checkBudgetAlerts(deps, QUIET, new Date(morning.getTime() + HOUR));
    expect(pushes).toHaveLength(1);
  });

  it('lets an urgent alert through quiet hours when the owner allowed it', async () => {
    const night = new Date('2026-10-13T01:00:00Z'); // 03:00
    await spend(7.8, night); // 97 %
    await checkBudgetAlerts(deps, QUIET, night);
    expect(pushes.map((p) => p.title)).toEqual(['Crédits API : 95 % du plafond du jour']);
  });

  it('announces a lasting pause once a day instead of every hour, and not in the middle of the night', async () => {
    const reason = 'crédits API indisponibles (plafond API quotidien atteint)';
    const start = new Date('2026-10-13T19:00:00Z'); // 21:00 in Zurich
    for (let h = 0; h <= 14; h++) {
      // Runs retry every 15 minutes while paused: each attempt reports the pause.
      for (const m of [0, 15, 30, 45]) await reportAllPaused(deps, QUIET, reason, { now: new Date(start.getTime() + h * HOUR + m * 60_000) });
    }
    expect(pushes.map((p) => p.title)).toEqual(['Ant est en pause', 'Ant est en pause']);
    expect((await getComputeState(t.ctx)).allPausedReason).toBe(reason);
    const days = (await t.ctx.db.select().from(budgetAlerts).where(eq(budgetAlerts.scope, 'all_paused'))).map((r) => r.periodKey).sort();
    expect(days).toEqual(['2026-10-13', '2026-10-14']);
  });

  it('announces a second pause the same day once compute came back in between', async () => {
    const reason = 'abonnement indisponible (limite de l’abonnement atteinte)';
    const at = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00Z`); // UTC, 2 h behind Zurich
    // Subscription only: the 5-hour limit is hit at 10:00 and lifts at 13:00…
    for (const hhmm of ['08:00', '08:15', '09:45']) await reportAllPaused(deps, QUIET, reason, { now: at(hhmm) });
    expect(pushes).toHaveLength(1);
    await clearAllPaused(deps);
    expect((await getComputeState(t.ctx)).allPausedReason).toBeNull();
    // …a run that finds compute available while nothing is paused changes nothing…
    await clearAllPaused(deps);
    // …and it is hit again at 19:00: a new pause, announced once again.
    for (const hhmm of ['17:00', '17:15', '17:30']) await reportAllPaused(deps, QUIET, reason, { now: at(hhmm) });
    expect(pushes.map((p) => p.title)).toEqual(['Ant est en pause', 'Ant est en pause']);
    expect((await getComputeState(t.ctx)).allPausedReason).toBe(reason);
  });

  it('reports a pause once even when several runs hit it at the same time', async () => {
    const now = new Date('2026-10-13T10:00:00Z');
    await Promise.all(Array.from({ length: 5 }, () => reportAllPaused(deps, QUIET, 'abonnement indisponible', { now })));
    expect(pushes).toHaveLength(1);
  });

  it('lets the pause of a waiting owner request through quiet hours when asked', async () => {
    await reportAllPaused(deps, QUIET, 'abonnement indisponible', { now: new Date('2026-10-13T01:00:00Z'), urgent: true });
    expect(pushes).toHaveLength(1);
  });

  it('reminds of the token expiry at a few steps, not every day', async () => {
    const createdAt = '2025-10-20T09:00:00.000Z';
    const settings: AppSettings = { ...NO_QUIET, subscriptionTokenCreatedAt: createdAt };
    const expires = new Date(createdAt).getTime() + 365 * DAY;
    for (let daysLeft = 35; daysLeft >= 1; daysLeft--) {
      // Hourly maintenance: several passes a day.
      for (const h of [0, 6, 12]) await tokenExpiryReminder(deps, settings, new Date(expires - daysLeft * DAY + h * HOUR));
    }
    expect(pushes.map((p) => p.title)).toEqual([
      'Jeton d’abonnement : expiration dans 30 jours',
      'Jeton d’abonnement : expiration dans 14 jours',
      'Jeton d’abonnement : expiration dans 7 jours',
      'Jeton d’abonnement : expiration dans 3 jours',
      'Jeton d’abonnement : expiration dans 1 jour',
    ]);
    expect(pushes.slice(3).every((p) => (p as PushPayload & { urgent?: boolean }).urgent)).toBe(true);

    // Expired: one reminder, then one a week while no new token is set.
    pushes.length = 0;
    for (let d = 0; d < 14; d++) await tokenExpiryReminder(deps, settings, new Date(expires + d * DAY + HOUR));
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    expect(pushes.length).toBeLessThanOrEqual(3);
    expect(pushes.every((p) => p.title === 'Jeton d’abonnement expiré')).toBe(true);

    // A new token starts its own reminders.
    pushes.length = 0;
    const renewed: AppSettings = { ...settings, subscriptionTokenCreatedAt: '2026-10-01T09:00:00.000Z' };
    const renewedExpiry = new Date(renewed.subscriptionTokenCreatedAt!).getTime() + 365 * DAY;
    await tokenExpiryReminder(deps, renewed, new Date(renewedExpiry - 20 * DAY));
    expect(pushes).toHaveLength(1);
  });
});
