import { inArray } from 'drizzle-orm';
import WebSocket from 'ws';
import { authSessions } from '../db/schema';
import { logger } from '../lib/logger';
import type { Ctx } from '../services/context';
import { isIdle, onSessionRevoked, revokeSession, type SessionConfig } from './session';

/** Close code the UI reads as "session over, sign in again". */
export const SESSION_CLOSE_CODE = 4401;
const CLOSE_REASON = 'session expirée';
/** A peer that never answers the close frame is cut off after this delay. */
const CLOSE_GRACE_MS = 2_000;

/**
 * Every WebSocket opened with a session (realtime feed, terminal, VNC) is tied to it here, so that it closes
 * as soon as the session ends: at once on revocation (logout, Settings, password change), and at the next
 * check for absolute expiry, idle expiry or a revocation made by another process.
 */
export class SessionSockets {
  private readonly sessionOf = new Map<WebSocket, string>();
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ctx: Ctx,
    private readonly cfg: SessionConfig,
    intervalMs = 30_000,
  ) {
    this.unsubscribe = onSessionRevoked((id) => this.closeSession(id));
    this.timer = setInterval(() => {
      this.revalidate().catch((err) => logger.warn({ err }, 'socket revalidation failed'));
    }, intervalMs);
    this.timer.unref();
  }

  /** Ties a socket to its session. A socket without a session is closed straight away. */
  track(socket: WebSocket, sessionId: string | undefined): void {
    if (!sessionId) {
      endSocket(socket);
      return;
    }
    this.sessionOf.set(socket, sessionId);
    const forget = () => this.sessionOf.delete(socket);
    socket.once('close', forget);
    socket.once('error', forget);
  }

  /** Closes every socket of a session. */
  closeSession(sessionId: string): number {
    let closed = 0;
    for (const [socket, id] of this.sessionOf) {
      if (id !== sessionId) continue;
      this.sessionOf.delete(socket);
      endSocket(socket);
      closed++;
    }
    return closed;
  }

  /** Closes the sockets whose session was revoked, expired or went idle. Returns how many were closed. */
  async revalidate(now = new Date()): Promise<number> {
    const ids = [...new Set(this.sessionOf.values())];
    if (ids.length === 0) return 0;
    const rows = await this.ctx.db.select().from(authSessions).where(inArray(authSessions.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    let closed = 0;
    for (const id of ids) {
      const row = byId.get(id);
      const live = !!row && !row.revokedAt && row.expiresAt > now;
      if (live && !isIdle(this.cfg, row, now)) continue;
      closed += this.closeSession(id);
      // Same policy as loadSession: an idle session is revoked, not merely disconnected.
      if (live) await revokeSession(this.ctx, id);
    }
    return closed;
  }

  size(): number {
    return this.sessionOf.size;
  }

  stop(): void {
    clearInterval(this.timer);
    this.unsubscribe();
  }
}

function endSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WebSocket.OPEN) socket.close(SESSION_CLOSE_CODE, CLOSE_REASON);
    else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  } catch (err) {
    logger.warn({ err }, 'socket close failed');
    socket.terminate();
  }
  // `ws` keeps delivering messages while CLOSING; never wait on the peer's acknowledgement.
  setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, CLOSE_GRACE_MS).unref();
}
