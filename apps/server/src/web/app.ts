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
import { loadSession } from './session';
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

/**
 * `true` trusts any proxy (fine only when the port is reachable from NPM alone, see the Proxmox firewall);
 * an IP / CIDR list trusts only those proxies for X-Forwarded-For (recommended: NPM's IP).
 */
export function trustProxySetting(value: string): boolean | string {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  return v;
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
  await computerRoutes(app, deps);
  const hub = await realtimeRoutes(app, deps);

  app.get('/healthz', { config: { public: true } }, async () => ({ ok: true }));

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
