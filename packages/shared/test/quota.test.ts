import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  alertsToSend,
  apiRemainingUsd,
  decideComputeSource,
  normaliseUtilisation,
  type ApiBudgetSnapshot,
  type DecisionInput,
  type SubscriptionSnapshot,
} from '../src/quota';

const now = new Date('2026-10-12T10:00:00Z');

const sub = (o: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  configured: true,
  limitedUntil: null,
  fiveHourUtil: null,
  sevenDayUtil: null,
  authFailed: false,
  ...o,
});

const api = (o: Partial<ApiBudgetSnapshot> = {}): ApiBudgetSnapshot => ({
  configured: true,
  authFailed: false,
  spentTodayUsd: 0,
  spentMonthUsd: 0,
  dailyCapUsd: 8,
  monthlyCapUsd: 100,
  botSpentTodayUsd: 0,
  botDailyCapUsd: null,
  ...o,
});

const input = (o: Partial<DecisionInput> = {}): DecisionInput => ({
  mode: 'subscription_then_api',
  priority: 'interactive',
  origin: 'user',
  now,
  subscription: sub(),
  api: api(),
  thresholds: DEFAULT_THRESHOLDS,
  perRunCapUsd: 2,
  ...o,
});

describe('decideComputeSource', () => {
  it('uses the subscription when available', () => {
    expect(decideComputeSource(input()).source).toBe('subscription');
  });

  it('falls back to API credits when the subscription is limited', () => {
    const d = decideComputeSource(input({ subscription: sub({ limitedUntil: new Date(now.getTime() + 3600_000) }) }));
    expect(d.source).toBe('api');
    if (d.source === 'api') expect(d.maxBudgetUsd).toBe(2);
  });

  it('returns to the subscription after the reset time', () => {
    const d = decideComputeSource(input({ subscription: sub({ limitedUntil: new Date(now.getTime() - 1) }) }));
    expect(d.source).toBe('subscription');
  });

  it('keeps background work off the subscription above the reserve threshold', () => {
    const s = sub({ fiveHourUtil: 65 });
    expect(decideComputeSource(input({ subscription: s, priority: 'background' })).source).toBe('api');
    expect(decideComputeSource(input({ subscription: s, priority: 'interactive' })).source).toBe('subscription');
  });

  it('moves interactive work to API above the hard threshold', () => {
    expect(decideComputeSource(input({ subscription: sub({ fiveHourUtil: 91 }) })).source).toBe('api');
    expect(decideComputeSource(input({ subscription: sub({ sevenDayUtil: 86 }) })).source).toBe('api');
  });

  it('weekly reserve also applies to background work', () => {
    expect(decideComputeSource(input({ subscription: sub({ sevenDayUtil: 55 }), priority: 'background' })).source).toBe('api');
  });

  it('pauses background work in subscription_only mode instead of using API', () => {
    const d = decideComputeSource(input({ mode: 'subscription_only', priority: 'background', subscription: sub({ fiveHourUtil: 70 }) }));
    expect(d.source).toBe('paused');
  });

  it('subscription_only pauses with the reset time when limited', () => {
    const until = new Date(now.getTime() + 600_000);
    const d = decideComputeSource(input({ mode: 'subscription_only', subscription: sub({ limitedUntil: until }) }));
    expect(d).toMatchObject({ source: 'paused', retryAt: until });
  });

  it('api_only never touches the subscription', () => {
    expect(decideComputeSource(input({ mode: 'api_only' })).source).toBe('api');
  });

  it('api_only pauses when the daily cap is reached', () => {
    const d = decideComputeSource(input({ mode: 'api_only', api: api({ spentTodayUsd: 8 }) }));
    expect(d.source).toBe('paused');
    expect(d.reason).toContain('quotidien');
  });

  it('pauses when both sources are exhausted', () => {
    const d = decideComputeSource(
      input({ subscription: sub({ limitedUntil: new Date(now.getTime() + 1000) }), api: api({ spentMonthUsd: 100 }) }),
    );
    expect(d.source).toBe('paused');
    expect(d.reason).toContain('mensuel');
  });

  it('hybrid_safe sends autonomous work to API and owner-triggered work to the subscription', () => {
    expect(decideComputeSource(input({ mode: 'hybrid_safe', origin: 'autonomous', priority: 'background' })).source).toBe('api');
    expect(decideComputeSource(input({ mode: 'hybrid_safe', origin: 'user' })).source).toBe('subscription');
  });

  it('hybrid_safe pauses autonomous work without API credits', () => {
    const d = decideComputeSource(input({ mode: 'hybrid_safe', origin: 'autonomous', api: api({ configured: false }) }));
    expect(d.source).toBe('paused');
  });

  it('caps maxBudgetUsd with the remaining budget and the bot cap', () => {
    const d = decideComputeSource(input({ mode: 'api_only', api: api({ spentTodayUsd: 7.5, botDailyCapUsd: 0.3, botSpentTodayUsd: 0.1 }) }));
    expect(d).toMatchObject({ source: 'api', maxBudgetUsd: 0.2 });
  });

  it('reports a bot cap reason', () => {
    const d = decideComputeSource(input({ mode: 'api_only', api: api({ botDailyCapUsd: 1, botSpentTodayUsd: 1 }) }));
    expect(d.reason).toContain('bot');
  });

  it('does not use a subscription whose token failed', () => {
    expect(decideComputeSource(input({ subscription: sub({ authFailed: true }) })).source).toBe('api');
  });
});

describe('apiRemainingUsd', () => {
  it('takes the smallest remaining cap', () => {
    expect(apiRemainingUsd(api({ spentTodayUsd: 3, spentMonthUsd: 98 }))).toBe(2);
  });
});

describe('alertsToSend', () => {
  it('returns newly reached thresholds only', () => {
    expect(alertsToSend(85, [50, 80, 95], [50])).toEqual([80]);
    expect(alertsToSend(96, [50, 80, 95], [])).toEqual([50, 80, 95]);
    expect(alertsToSend(40, [50, 80, 95], [])).toEqual([]);
    expect(alertsToSend(null, [50], [])).toEqual([]);
  });
});

describe('normaliseUtilisation', () => {
  it('accepts fractions and percentages', () => {
    expect(normaliseUtilisation(0.42)).toBe(42);
    expect(normaliseUtilisation(73)).toBe(73);
    expect(normaliseUtilisation(140)).toBe(100);
    expect(normaliseUtilisation(undefined)).toBeNull();
  });
});
