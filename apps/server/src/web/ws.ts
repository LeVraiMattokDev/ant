import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import WebSocket from 'ws';
import { authSessions } from '../db/schema';
import type { ServerEvent } from '@ant/shared';
import { runToDTO } from '../lib/dto';
import { subscribe, type WireEvent } from '../lib/events';
import { logger } from '../lib/logger';
import { getMessageDTO } from '../services/messages';
import { getRun } from '../services/runs';
import type { WebDeps } from './deps';

export interface RealtimeHub {
  broadcast(event: ServerEvent): void;
  clients(): number;
  close(): Promise<void>;
}

/** Fans Postgres NOTIFY events out to the connected browsers. */
export async function realtimeRoutes(app: FastifyInstance, deps: WebDeps): Promise<RealtimeHub> {
  const sockets = new Set<WebSocket>();
  const sessionOf = new Map<WebSocket, string>();
  const origin = new URL(deps.cfg.PUBLIC_ORIGIN).origin;

  const broadcast = (event: ServerEvent) => {
    const payload = JSON.stringify(event);
    for (const s of sockets) if (s.readyState === WebSocket.OPEN) s.send(payload);
  };

  const expand = async (event: WireEvent): Promise<ServerEvent | null> => {
    if (event.type === 'message.ref') {
      const message = await getMessageDTO(deps.ctx, event.messageId);
      return message ? { type: event.created ? 'message.created' : 'message.updated', message } : null;
    }
    if (event.type === 'run.ref') {
      const run = await getRun(deps.ctx, event.runId);
      return run ? { type: 'run.updated', run: runToDTO(run) } : null;
    }
    return event;
  };

  const unlisten = await subscribe(deps.ctx.sql, (event) => {
    if (sockets.size === 0) return;
    expand(event)
      .then((e) => e && broadcast(e))
      .catch((err) => logger.warn({ err }, 'event expansion failed'));
  });

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    if (req.headers.origin && req.headers.origin !== origin) {
      socket.close(1008, 'origine refusée');
      return;
    }
    sockets.add(socket);
    if (req.session) sessionOf.set(socket, req.session.id);
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        // ignore
      }
    });
    const forget = () => {
      sockets.delete(socket);
      sessionOf.delete(socket);
    };
    socket.on('close', forget);
    socket.on('error', forget);
  });

  // Close sockets whose session was revoked or expired (logout elsewhere, password change).
  const revalidate = setInterval(() => {
    void (async () => {
      const now = new Date();
      for (const [socket, id] of sessionOf) {
        const row = await deps.ctx.db.query.authSessions.findFirst({ where: eq(authSessions.id, id) });
        if (!row || row.revokedAt || row.expiresAt < now) socket.close(4401, 'session expirée');
      }
    })().catch((err) => logger.warn({ err }, 'socket revalidation failed'));
  }, 60_000);

  return {
    broadcast,
    clients: () => sockets.size,
    close: async () => {
      clearInterval(revalidate);
      for (const s of sockets) s.close(1001, 'arrêt');
      await unlisten();
    },
  };
}
