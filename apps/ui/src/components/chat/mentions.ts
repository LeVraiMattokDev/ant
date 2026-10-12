import type { BotDTO } from '@ant/shared';

export interface MentionQuery {
  /** Index of the "@" in the text. */
  start: number;
  /** Partial slug typed after "@". */
  query: string;
}

/** Detects an @mention being typed right before the caret. */
export function mentionAtCaret(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([a-zA-Z0-9-]{0,40})$/.exec(before);
  if (!m) return null;
  return { start: caret - (m[2]?.length ?? 0) - 1, query: (m[2] ?? '').toLowerCase() };
}

export function filterMentionCandidates(bots: BotDTO[], query: string, limit = 6): BotDTO[] {
  const q = query.toLowerCase();
  const scored = bots
    .map((b) => {
      const slug = b.slug.toLowerCase();
      const name = b.name.toLowerCase();
      const score = !q ? 1 : slug.startsWith(q) ? 3 : name.startsWith(q) ? 2 : slug.includes(q) || name.includes(q) ? 1 : 0;
      return { b, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.b.name.localeCompare(b.b.name, 'fr'));
  return scored.slice(0, limit).map((x) => x.b);
}

export function applyMention(text: string, mention: MentionQuery, caret: number, slug: string): { text: string; caret: number } {
  const insert = `@${slug} `;
  const next = text.slice(0, mention.start) + insert + text.slice(caret);
  return { text: next, caret: mention.start + insert.length };
}
