/** Removes secrets from values before they are logged or written to the audit log. */

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{10,}/g,
  /(?<=Bearer\s)[A-Za-z0-9._\-]{16,}/gi,
  /(?<=(?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi,
];

export function redactString(value: string, secrets: readonly string[] = []): string {
  let out = value;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[secret]');
  }
  for (const re of PATTERNS) out = out.replace(re, '[secret]');
  return out;
}

export function redactDeep<T>(value: T, secrets: readonly string[] = [], depth = 0): T {
  if (depth > 12) return '[profondeur max]' as unknown as T;
  if (typeof value === 'string') return redactString(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(password|passwd|secret|token|apiKey|api_key|authorization|cookie)$/i.test(k)) out[k] = '[secret]';
      else out[k] = redactDeep(v, secrets, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Truncates long strings in a JSON-able value (for audit storage). */
export function truncateDeep<T>(value: T, max = 2000, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === 'string') return (value.length > max ? `${value.slice(0, max)}… [${value.length - max} car. tronqués]` : value) as unknown as T;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => truncateDeep(v, max, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateDeep(v, max, depth + 1);
    return out as T;
  }
  return value;
}
