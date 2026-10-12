/** Time helpers that work with IANA time zones without extra dependencies. */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
  };
}

/** "YYYY-MM-DD" of `date` in `timeZone`. */
export function localDateKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** "YYYY-MM" of `date` in `timeZone`. */
export function localMonthKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export interface TimeRange {
  /** "HH:MM" */
  start: string;
  /** "HH:MM" */
  end: string;
}

export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`Heure invalide : ${value}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Heure invalide : ${value}`);
  return h * 60 + min;
}

export function isValidHHMM(value: string): boolean {
  try {
    parseHHMM(value);
    return true;
  } catch {
    return false;
  }
}

/** True when `date` falls inside the quiet-hours range (ranges may wrap past midnight). */
export function isWithinRange(date: Date, timeZone: string, range: TimeRange | null): boolean {
  if (!range) return false;
  const p = localParts(date, timeZone);
  const now = p.hour * 60 + p.minute;
  const start = parseHHMM(range.start);
  const end = parseHHMM(range.end);
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

/** Minutes since local midnight. */
export function localMinutes(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
