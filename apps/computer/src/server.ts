import { createReadStream, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ComputerHealth } from '@ant/shared';
import type { z } from 'zod';
import { isAuthorizedRequest } from './auth';
import type { BrowserManager } from './browser/browser';
import { BrowserActionError } from './browser/browser';
import { displaySocket, type Config } from './config';
import { badRequest, HttpError, toHttpError } from './errors';
import { runCommand } from './exec';
import {
  contentDisposition,
  deleteWorkspacePath,
  editWorkspaceFile,
  listWorkspaceDir,
  prepareDownload,
  readWorkspaceFile,
  writeWorkspaceFile,
} from './files';
import {
  browserSchema,
  execSchema,
  fileDeleteSchema,
  fileEditSchema,
  fileListSchema,
  fileReadSchema,
  fileWriteSchema,
  formatZodError,
  inspectSchema,
} from './schemas';
import { attachWebSockets, type WsDeps } from './ws';

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface ServerDeps {
  cfg: Config;
  /** Absent in tests that do not need a browser. */
  browser?: BrowserManager;
  ws?: Partial<WsDeps>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: HttpError): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, err.status, { error: err.code, message: err.message });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Corps de requête trop volumineux (5 Mo maximum).');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Corps de requête trop volumineux (5 Mo maximum).');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw badRequest('Corps JSON invalide.');
  }
}

async function parseBody<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.output<S>> {
  const raw = await readBody(req);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest(`Requête invalide — ${formatZodError(parsed.error)}`);
  return parsed.data;
}

function requireBrowser(deps: ServerDeps): BrowserManager {
  if (!deps.browser) throw new HttpError(503, 'browser_unavailable', 'Navigateur indisponible sur cet ordinateur.');
  return deps.browser;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export function buildRoutes(deps: ServerDeps): Map<string, Handler> {
  const { cfg } = deps;
  const root = cfg.workspaceRoot;
  const routes = new Map<string, Handler>();
  const json = (method: string, route: string, fn: (req: IncomingMessage, url: URL) => Promise<unknown>): void => {
    routes.set(`${method} ${route}`, async (req, res, url) => sendJson(res, 200, await fn(req, url)));
  };

  json('GET', '/health', async () => {
    const health: ComputerHealth = {
      ok: true,
      display: cfg.headless || existsSync(displaySocket(cfg.display)),
      browser: deps.browser?.alive ?? false,
      url: deps.browser?.currentUrl() ?? null,
    };
    return health;
  });

  json('POST', '/exec', async (req) => runCommand(cfg, await parseBody(req, execSchema)));
  json('POST', '/files/read', async (req) => readWorkspaceFile(root, await parseBody(req, fileReadSchema)));
  json('POST', '/files/write', async (req) => writeWorkspaceFile(root, await parseBody(req, fileWriteSchema)));
  json('POST', '/files/edit', async (req) => editWorkspaceFile(root, await parseBody(req, fileEditSchema)));
  json('POST', '/files/list', async (req) => listWorkspaceDir(root, (await parseBody(req, fileListSchema)).path));
  json('POST', '/files/delete', async (req) => deleteWorkspacePath(root, (await parseBody(req, fileDeleteSchema)).path));
  json('POST', '/browser', async (req) => {
    const body = await parseBody(req, browserSchema);
    return requireBrowser(deps).run(body);
  });
  json('POST', '/browser/inspect', async (req) => {
    const body = await parseBody(req, inspectSchema);
    try {
      return await requireBrowser(deps).inspect(body);
    } catch (err) {
      if (err instanceof BrowserActionError) throw badRequest(err.message);
      throw err;
    }
  });

  routes.set('GET /files/download', async (_req, res, url) => {
    const file = await prepareDownload(root, url.searchParams.get('path') ?? undefined);
    const stream = createReadStream(file.abs);
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': file.size,
          'content-disposition': contentDisposition(file.name),
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        stream.pipe(res);
      });
      stream.once('error', reject);
      res.once('close', () => {
        stream.destroy();
        resolve();
      });
      stream.once('end', resolve);
    });
  });

  return routes;
}

export function createComputerServer(deps: ServerDeps): Server {
  const routes = buildRoutes(deps);
  const knownPaths = new Set([...routes.keys()].map((k) => k.split(' ')[1]));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://computer');
    try {
      // Liveness probe for the Docker HEALTHCHECK: unauthenticated, reveals nothing.
      if (url.pathname === '/livez' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': 2 });
        res.end(req.method === 'HEAD' ? undefined : 'ok');
        return;
      }
      if (!isAuthorizedRequest(req.headers, deps.cfg.token)) {
        throw new HttpError(401, 'unauthorized', 'Jeton manquant ou invalide.');
      }
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (!handler) {
        if (knownPaths.has(url.pathname)) throw new HttpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        throw new HttpError(404, 'not_found', `Route inconnue : ${url.pathname}`);
      }
      await handler(req, res, url);
    } catch (err) {
      const httpErr = toHttpError(err);
      if (httpErr.status >= 500) console.error(`[computer] ${req.method} ${url.pathname} :`, err);
      // Unread body (e.g. 401/413): do not keep the connection around.
      if (!req.complete && !res.headersSent) res.setHeader('connection', 'close');
      sendError(res, httpErr);
      if (!req.complete) req.resume();
    }
  });
  server.headersTimeout = 60_000;
  server.requestTimeout = 120_000; // receiving the request only; long /exec responses are not limited
  attachWebSockets(server, { cfg: deps.cfg, ...deps.ws });
  return server;
}
