import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { ServerEvent } from '@ant/shared';
import { runToDTO } from '../lib/dto';
import { subscribe, type WireEvent } from '../lib/events';
import { logger } from '../lib/logger';
import { getMessageDTO } from '../services/messages';
import { getRun } from '../services/runs';
import type { WebDeps } from './deps';
import type { SessionSockets } from './session-sockets';

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
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === 'ping' && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        // ignore
      }
    });
    const forget = () => sockets.delete(socket);
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
