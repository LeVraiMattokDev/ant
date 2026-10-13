import { isIPv4, isIPv6 } from 'node:net';
import { and, eq, ne } from 'drizzle-orm';
import { authSessions, settings } from '../db/schema';
import { audit } from '../lib/audit';
import { getSettings } from '../lib/settings';
import { logger } from '../lib/logger';
import type { Ctx } from '../services/context';
import { notifyOwner } from '../services/push';
import type { WebDeps } from './deps';

/** Keys of the `settings` table holding authentication state (the app settings live under 'app'). */
const TOTP_STEP_KEY = 'security.totp_last_step';
const LOCK_ALERT_KEY = 'security.lock_alert_at';

/**
 * Accepts a TOTP time step only if it is later than the last one accepted (RFC 6238 §5.2: a code works once).
 * A single conditional upsert, so two requests carrying the same code cannot both succeed.
 */
export async function claimTotpStep(ctx: Ctx, step: number): Promise<boolean> {
  const rows = await ctx.sql`
    insert into settings (key, value) values (${TOTP_STEP_KEY}, to_jsonb(${step}::bigint))
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (settings.value #>> '{}')::bigint < ${step}::bigint
    returning key`;
  return rows.length > 0;
}

/** A new TOTP secret starts with no used step. */
export async function resetTotpSteps(ctx: Ctx): Promise<void> {
  await ctx.db.delete(settings).where(eq(settings.key, TOTP_STEP_KEY));
}

/** True at most once an hour: the global lock alert must not fire on every refused attempt. */
async function claimLockAlert(ctx: Ctx): Promise<boolean> {
  const rows = await ctx.sql`
    insert into settings (key, value) values (${LOCK_ALERT_KEY}, to_jsonb(now()))
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (settings.value #>> '{}')::timestamptz < now() - interval '1 hour'
    returning key`;
  return rows.length > 0;
}

export interface SecurityAlert {
  title: string;
  body: string;
}

/**
 * In-app toast + Web Push for a security event (quiet hours respected unless urgent pushes are allowed).
 * Never fails the request that triggered it; the push itself is sent in the background.
 */
export async function securityAlert(deps: WebDeps, alert: SecurityAlert): Promise<void> {
  try {
    const appSettings = await getSettings(deps.ctx.db);
    void notifyOwner(deps.ctx, deps.push, appSettings, { ...alert, level: 'warning', urgent: true, url: '/settings', tag: 'security' }).catch((err) =>
      logger.warn({ err }, 'security alert failed'),
    );
  } catch (err) {
    logger.warn({ err }, 'security alert failed');
  }
}

export async function alertLocked(deps: WebDeps, ip: string, step: 'password' | 'second_factor' | 'setup'): Promise<void> {
  if (!(await claimLockAlert(deps.ctx).catch(() => false))) return;
  await audit(deps.ctx.db, { actor: 'anonyme', event: 'auth.locked', detail: { step }, ip, outcome: 'failed' });
  const what = step === 'password' ? 'la connexion par mot de passe' : step === 'second_factor' ? 'la saisie du second facteur' : 'l’initialisation';
  await securityAlert(deps, {
    title: 'Connexion verrouillée',
    body: `Trop de tentatives échouées en une heure (dernière depuis ${ip}) : ${what} est bloquée pendant une heure. Les passkeys restent utilisables.`,
  });
}

/** Network prefix used to recognise a known place: /24 in IPv4, /48 in IPv6 (mobile addresses move within it). */
export function ipPrefix(ip: string | null | undefined): string {
  if (!ip) return '';
  const v4 = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIPv6(ip)) {
    const [head = '', tail = ''] = ip.toLowerCase().split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return `${groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/48`;
  }
  return ip;
}

/** User agent without version numbers, so a browser update is not a new browser. */
export function browserFingerprint(userAgent: string | null | undefined): string {
  return (userAgent ?? '').replace(/\d+([._]\d+)*/g, '').replace(/\s+/g, ' ').trim();
}

export function describeUserAgent(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} sur ${os}`;
  return browser ?? os ?? 'navigateur inconnu';
}

/** A full login from a network prefix or a browser never seen in the stored sessions. */
export async function isNewDevice(ctx: Ctx, currentSessionId: string, ip: string, userAgent: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ ip: authSessions.ip, userAgent: authSessions.userAgent })
    .from(authSessions)
    .where(and(eq(authSessions.stage, 'full'), ne(authSessions.id, currentSessionId)));
  const prefix = ipPrefix(ip);
  const browser = browserFingerprint(userAgent);
  const knownPlace = rows.some((r) => ipPrefix(r.ip) === prefix);
  const knownBrowser = rows.some((r) => browserFingerprint(r.userAgent) === browser);
  return !knownPlace || !knownBrowser;
}
