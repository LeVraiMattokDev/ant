import type { ComputeSource, UsageRowDTO } from '@ant/shared';

export type UsageMetric = 'cost' | 'tokens';

export interface DayBucket {
  day: string;
  subscription: number;
  api: number;
}

export interface GroupRow {
  key: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  subscriptionCostUsd: number;
  apiCostUsd: number;
}

export function metricOf(row: UsageRowDTO, metric: UsageMetric): number {
  return metric === 'cost' ? row.costUsd : row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One bucket per calendar day over the last `days` days (oldest first), missing days filled with zeros. */
export function bucketByDay(rows: UsageRowDTO[], days: number, metric: UsageMetric, today = new Date()): DayBucket[] {
  const map = new Map<string, DayBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const k = dayKey(d);
    map.set(k, { day: k, subscription: 0, api: 0 });
  }
  for (const r of rows) {
    const b = map.get(r.day.slice(0, 10));
    if (!b) continue;
    b[r.computeSource satisfies ComputeSource] += metricOf(r, metric);
  }
  return [...map.values()];
}

/** Totals grouped by an arbitrary key (bot, model), sorted by total cost descending. */
export function groupUsage(rows: UsageRowDTO[], keyOf: (r: UsageRowDTO) => string): GroupRow[] {
  const map = new Map<string, GroupRow>();
  for (const r of rows) {
    const key = keyOf(r);
    const g = map.get(key) ?? {
      key,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      subscriptionCostUsd: 0,
      apiCostUsd: 0,
    };
    g.runs += r.runs;
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    g.cacheTokens += r.cacheReadTokens + r.cacheWriteTokens;
    if (r.computeSource === 'api') g.apiCostUsd += r.costUsd;
    else g.subscriptionCostUsd += r.costUsd;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.apiCostUsd + b.subscriptionCostUsd - (a.apiCostUsd + a.subscriptionCostUsd));
}

/** A "nice" axis maximum and tick step for `max`. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}
