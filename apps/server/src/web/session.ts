import { and, eq, gt, isNull, sql as dsql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authSessions, loginAttempts, type SessionStage } from '../db/schema';
import { randomToken, sha256 } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import type { Ctx } from '../services/context';

export interface SessionConfig {
  secureCookies: boolean;
  idleHours: number;
  absoluteDays: number;
}

export interface SessionInfo {
  id: string;
  stage: SessionStage;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionInfo | null;
  }
}

/** Stage sessions (setup/second factor in progress) are short-lived. */
const PARTIAL_TTL_MS = 10 * 60_000;

export function cookieName(cfg: SessionConfig): string {
  return cfg.secureCookies ? '__Host-ant_session' : 'ant_session';
}

export async function createSession(ctx: Ctx, cfg: SessionConfig, req: FastifyRequest, reply: FastifyReply, stage: SessionStage): Promise<void> {
  if (req.session) await revokeSession(ctx, req.session.id);
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = new Date(stage === 'full' ? now + cfg.absoluteDays * 86_400_000 : now + PARTIAL_TTL_MS);
  await ctx.db.insert(authSessions).values({
    id: sha256(token),
    stage,
    expiresAt,
    ip: req.ip,
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
  });
  reply.setCookie(cookieName(cfg), token, {
    path: '/',
    httpOnly: true,
    secure: cfg.secureCookies,
    sameSite: 'strict',
    expires: expiresAt,
  });
  req.session = { id: sha256(token), stage };
}

export async function upgradeSession(ctx: Ctx, cfg: SessionConfig, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // A fresh token on privilege change prevents session fixation.
  await createSession(ctx, cfg, req, reply, 'full');
}

export async function revokeSession(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, id));
}

export function clearSessionCookie(cfg: SessionConfig, reply: FastifyReply): void {
  reply.clearCookie(cookieName(cfg), { path: '/', secure: cfg.secureCookies, httpOnly: true, sameSite: 'strict' });
}

/** Resolves the session from the cookie; enforces idle and absolute expiry. */
export async function loadSession(ctx: Ctx, cfg: SessionConfig, req: FastifyRequest): Promise<SessionInfo | null> {
  const token = req.cookies[cookieName(cfg)];
  if (!token) return null;
  const id = sha256(token);
  const now = new Date();
  const row = await ctx.db.query.authSessions.findFirst({
    where: and(eq(authSessions.id, id), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now)),
  });
  if (!row) return null;
  if (row.stage === 'full' && now.getTime() - row.lastSeenAt.getTime() > cfg.idleHours * 3600_000) {
    await revokeSession(ctx, id);
    return null;
  }
  if (now.getTime() - row.lastSeenAt.getTime() > 60_000) {
    await ctx.db.update(authSessions).set({ lastSeenAt: now }).where(eq(authSessions.id, id));
  }
  return { id, stage: row.stage };
}

export function requireStage(req: FastifyRequest, stage: SessionStage): SessionInfo {
  if (!req.session || req.session.stage !== stage) {
    throw new HttpError(401, 'unauthenticated', stage === 'full' ? 'Connexion requise.' : 'Étape de connexion expirée, recommence.');
  }
  return req.session;
}

// ───────────────────────── Brute-force protection ─────────────────────────

const WINDOW_MS = 15 * 60_000;
const MAX_PER_IP = 5;
const MAX_GLOBAL_PER_HOUR = 50;

export async function assertNotThrottled(ctx: Ctx, ip: string, now = new Date()): Promise<void> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const [perIp] = await ctx.db
    .select({ n: dsql<number>`count(*)::int`, oldest: dsql<string | null>`min(${loginAttempts.at})` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false), gt(loginAttempts.at, since)));
  if ((perIp?.n ?? 0) >= MAX_PER_IP) {
    const retryAt = new Date(new Date(perIp!.oldest!).getTime() + WINDOW_MS);
    const minutes = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000));
    throw new HttpError(429, 'too_many_attempts', `Trop de tentatives échouées. Réessaie dans ${minutes} minute${minutes > 1 ? 's' : ''}.`);
  }
  const [global] = await ctx.db
    .select({ n: dsql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.success, false), gt(loginAttempts.at, new Date(now.getTime() - 3600_000))));
  if ((global?.n ?? 0) >= MAX_GLOBAL_PER_HOUR) {
    throw new HttpError(429, 'locked', 'Connexion temporairement verrouillée après de nombreux échecs. Réessaie dans une heure.');
  }
}

export async function recordAttempt(ctx: Ctx, ip: string, kind: string, success: boolean): Promise<void> {
  await ctx.db.insert(loginAttempts).values({ ip, kind, success });
}
