import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import { auditLog, runs } from '../../db/schema';
import { audit } from '../../lib/audit';
import { HttpError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { computerStatus, getComputerState, setComputerHolder } from '../../services/computer-state';
import { createMessage } from '../../services/messages';
import { requestRun } from '../../services/runs';
import type { WebDeps } from '../deps';
import type { SessionSockets } from '../session-sockets';
import { auditToDTO } from './system';

const COMPUTER_TOOLS = ['computer_exec', 'browser', 'file_write', 'file_edit'];

async function isOnline(deps: WebDeps): Promise<boolean> {
  if (!deps.computer.configured) return false;
  try {
    const h = await deps.computer.health();
    return h.ok;
  } catch {
    return false;
  }
}

function originAllowed(deps: WebDeps, req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  return !origin || origin === new URL(deps.cfg.PUBLIC_ORIGIN).origin;
}

/**
 * Bridges a browser WebSocket to the computer service, adding the RPC token. The bridge lives no longer than
 * the session that opened it: `sessionSockets` closes it on logout, revocation, password change or expiry.
 */
function bridge(deps: WebDeps, sessionSockets: SessionSockets, client: WebSocket, path: '/vnc' | '/terminal', binary: boolean, sessionId: string | undefined): void {
  if (!deps.computer.configured) {
    client.close(1011, 'ordinateur non configuré');
    return;
  }
  sessionSockets.track(client, sessionId);
  if (client.readyState !== WebSocket.OPEN) return;
  const upstream = new WebSocket(deps.computer.wsUrl(path), { headers: { authorization: deps.computer.authHeader } });
  const pending: { data: RawData; isBinary: boolean }[] = [];
  upstream.on('open', () => {
    if (client.readyState !== WebSocket.OPEN) return;
    for (const p of pending.splice(0)) upstream.send(p.data, { binary: p.isBinary });
  });
  client.on('message', (data, isBinary) => {
    // `ws` still delivers messages while the client socket is CLOSING (e.g. after a revocation): drop them.
    if (client.readyState !== WebSocket.OPEN) return;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 1000) pending.push({ data, isBinary });
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: binary || isBinary });
  });
  const closeBoth = (code?: number, reason?: string) => {
    const safeCode = code && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
    if (client.readyState === WebSocket.OPEN) client.close(safeCode, reason);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  };
  upstream.on('close', (code, reason) => closeBoth(code, reason.toString()));
  upstream.on('error', (err) => {
    logger.warn({ err, path }, 'computer websocket error');
    closeBoth(1011, 'ordinateur injoignable');
  });
  // The session sockets registry closes the client side; ending the upstream kills the shell / VNC stream.
  client.on('close', () => closeBoth());
  client.on('error', () => closeBoth());
}

export async function computerRoutes(app: FastifyInstance, deps: WebDeps, sessionSockets: SessionSockets): Promise<void> {
  const { ctx } = deps;

  app.get('/api/computer/status', async () => computerStatus(ctx, await isOnline(deps)));

  app.post('/api/computer/control', async (req) => {
    const { holder } = z.object({ holder: z.enum(['user', 'agents']) }).parse(req.body);
    const before = await getComputerState(ctx);
    // Health is checked once and shared by the live event and the response, so neither claims a dead machine is online.
    const online = await isOnline(deps);
    await setComputerHolder(ctx, holder, online);
    await audit(ctx.db, { actor: 'owner', event: holder === 'user' ? 'computer.takeover' : 'computer.release', ip: req.ip });
    if (holder === 'agents' && before.holder === 'user' && before.activeBotId) {
      // Wake up the bot that was using the computer, in the conversation it was working in.
      const [last] = await ctx.db
        .select()
        .from(runs)
        .where(and(eq(runs.botId, before.activeBotId), isNotNull(runs.channelId)))
        .orderBy(desc(runs.createdAt))
        .limit(1);
      if (last?.channelId) {
        await createMessage(ctx, {
          channelId: last.channelId,
          threadRootId: last.threadRootId,
          authorKind: 'system',
          content: '🖥️ Le propriétaire a rendu la main sur l’ordinateur.',
          meta: { kind: 'info' },
        });
        await requestRun(ctx, {
          botId: before.activeBotId,
          channelId: last.channelId,
          threadRootId: last.threadRootId,
          trigger: 'system',
          priority: 'interactive',
          origin: 'user',
          prompt: 'Le propriétaire t’a rendu la main sur l’ordinateur. Regarde l’état actuel (il a pu modifier des choses), puis reprends ta tâche là où tu t’étais arrêté.',
        });
      }
    }
    return computerStatus(ctx, online);
  });

  app.get<{ Querystring: { path?: string } }>('/api/computer/files', async (req) => {
    try {
      return await deps.computer.listFiles(req.query.path);
    } catch (err) {
      throw new HttpError(502, 'computer_error', (err as Error).message);
    }
  });

  app.get<{ Querystring: { path?: string } }>('/api/computer/files/download', async (req, reply) => {
    if (!req.query.path) throw new HttpError(400, 'missing_path', 'Chemin manquant.');
    let res: Response;
    try {
      res = await deps.computer.download(req.query.path);
    } catch (err) {
      throw new HttpError(502, 'download_failed', `Téléchargement impossible : ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpError(res.status === 404 ? 404 : 502, 'download_failed', 'Téléchargement impossible.');
    }
    await audit(ctx.db, { actor: 'owner', event: 'computer.download', detail: { path: req.query.path }, ip: req.ip });
    reply.header('content-type', res.headers.get('content-type') ?? 'application/octet-stream');
    reply.header('content-disposition', res.headers.get('content-disposition') ?? 'attachment');
    const length = res.headers.get('content-length');
    if (length && /^\d+$/.test(length)) reply.header('content-length', length);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    // Streamed with backpressure: the web service never holds the whole file (agents can create files of several GB).
    // Fastify cancels the upstream body if the browser goes away.
    return reply.send(res.body);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/computer/activity', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 300);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(inArray(auditLog.tool, COMPUTER_TOOLS)))
      .orderBy(desc(auditLog.id))
      .limit(limit);
    return rows.map(auditToDTO);
  });

  app.get('/api/computer/vnc', { websocket: true }, (socket, req) => {
    if (!originAllowed(deps, req)) return socket.close(1008, 'origine refusée');
    void audit(ctx.db, { actor: 'owner', event: 'computer.view', ip: req.ip });
    bridge(deps, sessionSockets, socket, '/vnc', true, req.session?.id);
  });

  app.get('/api/computer/terminal', { websocket: true }, (socket, req) => {
    if (!originAllowed(deps, req)) return socket.close(1008, 'origine refusée');
    void audit(ctx.db, { actor: 'owner', event: 'computer.terminal', ip: req.ip });
    bridge(deps, sessionSockets, socket, '/terminal', false, req.session?.id);
  });
}
