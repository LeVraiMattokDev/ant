/** @mention parsing and bot handle helpers. */

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Returns the distinct slugs mentioned as `@slug` in `text`, restricted to `knownSlugs`, in order of appearance. */
export function extractMentions(text: string, knownSlugs: readonly string[]): string[] {
  const known = new Set(knownSlugs.map((s) => s.toLowerCase()));
  const found: string[] = [];
  const re = /(^|[^\w@])@([a-zA-Z0-9][a-zA-Z0-9-]{0,39})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slug = (m[2] ?? '').toLowerCase().replace(/-+$/, '');
    if (known.has(slug) && !found.includes(slug)) found.push(slug);
  }
  return found;
}
