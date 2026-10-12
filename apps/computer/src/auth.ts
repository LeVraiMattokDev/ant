import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time check of `Authorization: Bearer <token>`.
 * Both sides are hashed first so the comparison does not leak the token length either.
 */
export function isAuthorized(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  const presented = match?.[1] ?? '';
  const ok = timingSafeEqual(digest(presented), digest(token));
  return ok && presented.length > 0;
}

export function isAuthorizedRequest(headers: IncomingHttpHeaders, token: string): boolean {
  return isAuthorized(headers.authorization, token);
}
