const LOCALE = 'fr-CH';

const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const dateYearFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dayHeaderFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

/** "14:02", "hier 14:02", "3 mars 14:02", "3 mars 2025". */
export function formatShort(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (sameDay(d, now)) return timeFmt.format(d);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `hier ${timeFmt.format(d)}`;
  if (d.getFullYear() === now.getFullYear()) return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
  return dateYearFmt.format(d);
}

export function formatFull(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : fullFmt.format(d);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateYearFmt.format(d);
}

export function formatDayHeader(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return 'Aujourd’hui';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Hier';
  const s = dayHeaderFmt.format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function isSameDay(a: string, b: string): boolean {
  return sameDay(new Date(a), new Date(b));
}

/** "dans 3 h", "il y a 5 min". */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = t - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  let s: string;
  if (min < 1) return diff >= 0 ? 'dans un instant' : 'à l’instant';
  if (min < 60) s = `${min} min`;
  else if (min < 60 * 48) s = `${Math.round(min / 60)} h`;
  else s = `${Math.round(min / 1440)} j`;
  return diff >= 0 ? `dans ${s}` : `il y a ${s}`;
}

/** API costs are small: keep 4 decimals under 1 $, 2 above. */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n !== 0 && Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)} k`;
  return String(n);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
  return `${(n / 1024 ** 3).toFixed(1)} Go`;
}

export function formatDuration(startIso: string | null, endIso: string | null, now = Date.now()): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : now;
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

export function formatPercent(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${Math.round(n)} %`;
}

/** Value for <input type="date"> from an ISO string. */
export function toDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

export function heartbeatLabel(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? 'chaque jour' : `tous les ${min / 1440} jours`;
  if (min % 60 === 0) return min === 60 ? 'toutes les heures' : `toutes les ${min / 60} h`;
  return `toutes les ${min} min`;
}
