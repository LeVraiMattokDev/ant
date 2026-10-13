import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@ant/shared';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { WebDeps } from './deps';
import { approvalRoutes } from './routes/approvals';
import { authRoutes } from './routes/auth';
import { botRoutes } from './routes/bots';
import { channelRoutes } from './routes/channels';
import { computerRoutes } from './routes/computer';
import { knowledgeRoutes } from './routes/knowledge';
import { quotaRoutes } from './routes/quota';
import { routineRoutes } from './routes/routines';
import { systemRoutes } from './routes/system';
import { registerModuleRoutes, startWebModules } from './modules';
import { loadSession } from './session';
import { SessionSockets } from './session-sockets';
import { realtimeRoutes, type RealtimeHub } from './ws';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Route reachable without a session. */
    public?: boolean;
    /** Route reachable with a partial session at this stage. */
    stage?: 'mfa' | 'enroll';
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** /healthz answers 503 when the database has not answered `select 1` within this delay. */
const HEALTHZ_DB_TIMEOUT_MS = 3_000;

/**
 * Which peers may set the client address through X-Forwarded-For (passed to proxy-addr by Fastify):
 * - an IP / CIDR list, e.g. NPM's address (recommended), or the names loopback, linklocal, uniquelocal
 *   (the default: private networks, so an Internet client cannot forge its address through NPM);
 * - `true` trusts every hop, so the leftmost X-Forwarded-For entry wins, and any client chooses it
 *   (NPM appends the real address on the right): per-IP throttling, sessions and the audit log become forgeable;
 * - `false` ignores the header (every client then shares NPM's address).
 */
export function trustProxySetting(value: string): boolean | string {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  return v;
}

/** Postgres SQLSTATE of a failed query: drizzle wraps the driver error in `cause`. */
function pgErrorCode(err: unknown): unknown {
  return (err as { cause?: { code?: unknown } }).cause?.code ?? (err as { code?: unknown }).code;
}

export interface BuiltApp {
  app: FastifyInstance;
  hub: RealtimeHub;
}

export async function buildApp(deps: WebDeps, opts: { serveUi?: boolean; rpc?: Parameters<typeof routineRoutes>[2] } = {}): Promise<BuiltApp> {
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: trustProxySetting(deps.cfg.TRUST_PROXY),
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: true,
  });
  const origin = new URL(deps.cfg.PUBLIC_ORIGIN);
  const wsOrigin = `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`;
  if (deps.cfg.NODE_ENV === 'production') {
    const trust = trustProxySetting(deps.cfg.TRUST_PROXY);
    if (trust === true) {
      app.log.warn(
        'TRUST_PROXY=true : n’importe quel client peut choisir son adresse IP via X-Forwarded-For (limites de connexion contournables, IP falsifiées dans l’audit et les sessions). Mets l’IP de Nginx Proxy Manager (GET /api/system/network indique l’adresse vue par Ant).',
      );
    } else if (typeof trust === 'string' && /\b(uniquelocal|linklocal)\b/.test(trust)) {
      app.log.info(
        'TRUST_PROXY fait confiance aux réseaux privés : indique l’IP exacte de Nginx Proxy Manager pour que ni le réseau local ni l’ordinateur des agents ne puissent choisir leur adresse IP.',
      );
    }
  }

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", wsOrigin],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: origin.protocol === 'https:' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: origin.protocol === 'https:' ? { maxAge: 31_536_000, includeSubDomains: false } : false,
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req, reply) => {
    // Decide on the matched route pattern, not the raw URL: the router percent-decodes the path before
    // matching, so `/%61pi/bots` reaches the `/api/bots` handler while `req.url` does not start with `/api/`.
    // Unmatched URLs fall through to the not-found handler, which serves no data.
    const route = req.routeOptions.url;
    if (!route?.startsWith('/api/')) return;
    if (MUTATING.has(req.method)) {
      const requestedWith = req.headers['x-requested-with'];
      const reqOrigin = req.headers.origin;
      if (requestedWith !== 'ant' || (reqOrigin && reqOrigin !== origin.origin)) {
        return reply.code(403).send({ error: 'csrf', message: 'Requête refusée (origine non autorisée).' } satisfies ApiErrorBody);
      }
    }
    req.session = await loadSession(deps.ctx, deps.session, req);
    const cfg = req.routeOptions.config;
    if (cfg?.public) return;
    if (cfg?.stage && req.session?.stage === cfg.stage) return;
    if (req.session?.stage !== 'full') {
      return reply.code(401).send({ error: 'unauthenticated', message: 'Connexion requise.' } satisfies ApiErrorBody);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details } satisfies ApiErrorBody);
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({
        error: 'invalid_request',
        message: first ? `${first.path.length ? `${first.path.join('.')} : ` : ''}${first.message}` : 'Requête invalide.',
        details: err.issues,
      } satisfies ApiErrorBody);
    }
    if (pgErrorCode(err) === '22P02') {
      // Malformed identifier or value in the path or query (e.g. a truncated link): the client's mistake, not a crash.
      return reply.code(400).send({ error: 'invalid_request', message: 'Identifiant ou paramètre invalide.' } satisfies ApiErrorBody);
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'request_error', message: status === 429 ? 'Trop de requêtes, ralentis un peu.' : (err as Error).message } satisfies ApiErrorBody);
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Erreur interne du serveur.' } satisfies ApiErrorBody);
  });

  await authRoutes(app, deps);
  await botRoutes(app, deps);
  await channelRoutes(app, deps);
  await knowledgeRoutes(app, deps);
  await routineRoutes(app, deps, opts.rpc);
  await approvalRoutes(app, deps);
  await quotaRoutes(app, deps);
  await systemRoutes(app, deps);
  // Feature modules (web/modules/*): each team registers its routes in its own module file.
  await registerModuleRoutes(app, deps);
  // Every session-bound WebSocket (realtime, terminal, VNC) closes when its session ends.
  const sessionSockets = new SessionSockets(deps.ctx, deps.session);
  app.addHook('onClose', async () => sessionSockets.stop());
  await computerRoutes(app, deps, sessionSockets);
  const hub = await realtimeRoutes(app, deps, sessionSockets);
  const stopModules = await startWebModules(deps, hub);
  app.addHook('onClose', stopModules);

  // Container healthcheck (and an optional external probe): healthy only while the database answers.
  app.get('/healthz', { config: { public: true } }, async (_req, reply) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        deps.ctx.sql`select 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), HEALTHZ_DB_TIMEOUT_MS);
        }),
      ]);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: 'database_unreachable' });
    } finally {
      clearTimeout(timer);
    }
  });

  const uiDist = deps.cfg.UI_DIST;
  if (opts.serveUi !== false && existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: '/', wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Route inconnue.' });
      if (req.method !== 'GET') return reply.code(404).send();
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Route inconnue.' }));
  }
  return { app, hub };
}
