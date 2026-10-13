import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { ClientEvent, ServerEvent } from '@ant/shared';
import { runToDTO } from '../lib/dto';
import { subscribe, type WireEvent } from '../lib/events';
import { logger } from '../lib/logger';
import { getMessageDTO } from '../services/messages';
import { getRun } from '../services/runs';
import type { WebDeps } from './deps';
import { connectionClosed, dispatchClientEvent, type RealtimeConnection } from './modules';
import type { SessionSockets } from './session-sockets';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates a browser message on /api/ws (ClientEvent); anything else is ignored. */
export function parseClientEvent(raw: string): ClientEvent | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type === 'ping') return { type: 'ping' };
  if (m.type === 'focus') {
    const channelId = m.channelId === null || m.channelId === undefined ? null : m.channelId;
    if (channelId !== null && (typeof channelId !== 'string' || !UUID_RE.test(channelId))) return null;
    if (typeof m.visible !== 'boolean') return null;
    return { type: 'focus', channelId, visible: m.visible };
  }
  return null;
}

export interface RealtimeHub {
  broadcast(event: ServerEvent): void;
  clients(): number;
  /** Closes the sockets (realtime, terminal, VNC) whose session was revoked, expired or went idle. */
  revalidateSessions(): Promise<number>;
  close(): Promise<void>;
}

/** Fans Postgres NOTIFY events out to the connected browsers. */
export async function realtimeRoutes(app: FastifyInstance, deps: WebDeps, sessionSockets: SessionSockets): Promise<RealtimeHub> {
  const sockets = new Set<WebSocket>();
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
    sessionSockets.track(socket, req.session?.id);
    const connection: RealtimeConnection = {
      id: randomUUID(),
      sessionId: req.session?.id ?? null,
      send: (event) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      },
    };
    socket.on('message', (raw) => {
      // `ws` still delivers messages while the socket is CLOSING (e.g. after a revocation): drop them.
      if (socket.readyState !== WebSocket.OPEN) return;
      const event = parseClientEvent(raw.toString());
      if (!event) return;
      if (event.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      // Feature modules (web/modules), e.g. presence.
      void dispatchClientEvent(deps, connection, event);
    });
    let closed = false;
    const forget = () => {
      sockets.delete(socket);
      if (closed) return;
      closed = true;
      void connectionClosed(deps, connection);
    };
    socket.on('close', forget);
    socket.on('error', forget);
  });

  return {
    broadcast,
    clients: () => sockets.size,
    revalidateSessions: () => sessionSockets.revalidate(),
    close: async () => {
      sessionSockets.stop();
      for (const s of sockets) s.close(1001, 'arrêt');
      await unlisten();
    },
  };
}
