/** Pure helpers for the conversation list: previews, list timestamps, live activity. */
import type { BotDTO, ChannelDTO, RunDTO } from '@ant/shared';

const LOCALE = 'fr-CH';
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const dayYearFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "17:47" today, "hier", "3 oct." this year, "3 oct. 2025" before. */
export function formatListTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (sameDay(d, now)) return timeFmt.format(d);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'hier';
  return d.getFullYear() === now.getFullYear() ? dayFmt.format(d) : dayYearFmt.format(d);
}

/** Markdown → one plain line, for list previews. */
export function stripMarkdown(src: string): string {
  let s = src ?? '';
  s = s.replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (_m, code: string) => ` ${code} `);
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '');
  s = s.replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, ' ');
  s = s.replace(/\|/g, ' ');
  s = s.replace(/^\s*([-*_]\s*){3,}$/gm, ' ');
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
  s = s.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/`([^`]*)`/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

/** Preview line of a channel: "Toi : …" for the owner, "Dev : …" for another bot in a group. */
export function previewText(channel: Pick<ChannelDTO, 'kind' | 'lastMessage'>, bots: Map<string, Pick<BotDTO, 'name'>>): string {
  const m = channel.lastMessage;
  if (!m) return 'Aucun message pour le moment';
  const body = stripMarkdown(m.content) || '…';
  if (m.authorKind === 'user') return `Toi : ${body}`;
  if (m.authorKind === 'bot' && channel.kind === 'group') {
    const name = m.botId ? bots.get(m.botId)?.name : undefined;
    if (name) return `${name} : ${body}`;
  }
  return body;
}

/** Lower-cases the first letter of an activity so it reads after the bot name. */
function phrase(activity: string): string {
  const a = activity.trim().replace(/[.…]+$/, '');
  return a.charAt(0).toLowerCase() + a.slice(1);
}

/**
 * Live state of a bot for the list, or null when idle: waiting for an approval, queued,
 * or working (its activity, else "écrit…" while a run is active in its conversation).
 */
export function botLiveState(
  bot: Pick<BotDTO, 'id' | 'activity' | 'paused'>,
  runs: Pick<RunDTO, 'botId' | 'channelId' | 'status' | 'activity'>[] | undefined,
  channelId?: string,
): { label: string; tone: 'working' | 'waiting' } | null {
  const mine = (runs ?? []).filter((r) => r.botId === bot.id);
  if (mine.some((r) => r.status === 'waiting_approval')) return { label: 'attend ta validation', tone: 'waiting' };
  const running = mine.find((r) => r.status === 'running' && (!channelId || r.channelId === channelId)) ?? mine.find((r) => r.status === 'running');
  if (running) {
    if (running.activity) return { label: phrase(running.activity), tone: 'working' };
    // No precise activity: in its own conversation the bot is writing the reply.
    if (!channelId || running.channelId === channelId) return { label: 'écrit…', tone: 'working' };
    return { label: bot.activity ? phrase(bot.activity) : 'au travail', tone: 'working' };
  }
  if (bot.activity) return { label: phrase(bot.activity), tone: 'working' };
  if (mine.some((r) => r.status === 'queued')) return { label: 'en file d’attente', tone: 'waiting' };
  return null;
}

/** Case- and accent-insensitive match used by the sidebar search field. */
export function matchesQuery(q: string, ...fields: (string | null | undefined)[]): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const needle = norm(q.trim());
  if (!needle) return true;
  return fields.some((f) => f && norm(f).includes(needle));
}
