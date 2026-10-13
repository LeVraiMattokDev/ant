import { accessSync, constants } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { isAuthorizedRequest } from './auth';
import { agentEnv, DEFAULT_PATH, type Config } from './config';

export interface PtyLike {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type SpawnPty = (file: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyLike;

export interface WsDeps {
  cfg: Config;
  /** node-pty spawn (injectable for tests). Loaded lazily: it is a native module. */
  spawnPty?: SpawnPty;
}

/** Above this much unsent data to the browser, stop reading from the VNC server. */
const WS_HIGH_WATER = 4 * 1024 * 1024;

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  const body = JSON.stringify({ error: status === 401 ? 'unauthorized' : 'not_found', message: text });
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * websockify-like bridge: WebSocket binary frames <-> x11vnc's unix socket (RFB). x11vnc has no
 * TCP port on purpose: web pages opened in Chromium could reach a loopback one (see entrypoint.sh).
 */
export function bridgeVnc(ws: WebSocket, socketPath: string): void {
  const vnc: Socket = connect({ path: socketPath });
  let closed = false;
  const closeBoth = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    vnc.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
  };

  vnc.on('data', (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true }, () => {
      if (vnc.isPaused() && ws.bufferedAmount < WS_HIGH_WATER / 2) vnc.resume();
    });
    if (ws.bufferedAmount > WS_HIGH_WATER) vnc.pause();
  });
  vnc.on('end', () => closeBoth(1000, 'VNC fermé'));
  vnc.on('close', () => closeBoth(1000, 'VNC fermé'));
  vnc.on('error', (err) => closeBoth(1011, `VNC injoignable : ${err.message}`.slice(0, 120)));

  ws.on('message', (data) => {
    if (!closed) vnc.write(toBuffer(data));
  });
  ws.on('close', () => closeBoth(1000, ''));
  ws.on('error', () => closeBoth(1011, ''));
}

function findInPath(bin: string): string | null {
  for (const dir of DEFAULT_PATH.split(':')) {
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** tmux shared session "ant" (attach or create), or a login bash if tmux is missing. */
export function terminalCommand(): { file: string; args: string[] } {
  const tmux = findInPath('tmux');
  if (tmux) return { file: tmux, args: ['new-session', '-A', '-s', 'ant'] };
  return { file: findInPath('bash') ?? '/bin/bash', args: ['-l'] };
}

export interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

/** `{"type":"resize","cols":N,"rows":N}` → clamped sizes, anything else → null (plain input). */
export function parseResize(text: string): ResizeMessage | null {
  if (!text.startsWith('{') || !text.includes('"resize"')) return null;
  try {
    const msg = JSON.parse(text) as Partial<ResizeMessage>;
    if (msg.type !== 'resize' || typeof msg.cols !== 'number' || typeof msg.rows !== 'number') return null;
    const clamp = (n: number, max: number): number => Math.min(Math.max(Math.floor(n), 1), max);
    return { type: 'resize', cols: clamp(msg.cols, 1000), rows: clamp(msg.rows, 500) };
  } catch {
    return null;
  }
}

let cachedSpawn: SpawnPty | null = null;
async function loadNodePty(): Promise<SpawnPty> {
  if (cachedSpawn) return cachedSpawn;
  const pty = await import('node-pty');
  cachedSpawn = (file, args, opts) => pty.spawn(file, args, { name: 'xterm-256color', ...opts });
  return cachedSpawn;
}

export async function bridgeTerminal(ws: WebSocket, deps: WsDeps): Promise<void> {
  const { cfg } = deps;
  let term: PtyLike;
  try {
    const spawnPty = deps.spawnPty ?? (await loadNodePty());
    const cmd = terminalCommand();
    term = spawnPty(cmd.file, cmd.args, {
      cols: 120,
      rows: 32,
      cwd: cfg.workspaceRoot,
      env: agentEnv(cfg, { SHELL: '/bin/bash' }),
    });
  } catch (err) {
    ws.close(1011, `Terminal indisponible : ${(err as Error).message}`.slice(0, 120));
    return;
  }

  let exited = false;
  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(() => {
    exited = true;
    if (ws.readyState === ws.OPEN) ws.close(1000, 'Terminal fermé');
  });
  ws.on('message', (data, isBinary) => {
    if (exited) return;
    const text = toBuffer(data).toString('utf8');
    if (!isBinary) {
      const resize = parseResize(text);
      if (resize) {
        term.resize(resize.cols, resize.rows);
        return;
      }
    }
    term.write(text);
  });
  ws.on('close', () => {
    // Kills this tmux client only: the shared "ant" session keeps running.
    if (!exited) term.kill();
  });
}

export function attachWebSockets(server: Server, deps: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const pathname = new URL(req.url ?? '/', 'http://computer').pathname;
    if (!isAuthorizedRequest(req.headers, deps.cfg.token)) {
      rejectUpgrade(socket, 401, 'Jeton manquant ou invalide.');
      return;
    }
    if (pathname !== '/vnc' && pathname !== '/terminal') {
      rejectUpgrade(socket, 404, `Route WebSocket inconnue : ${pathname}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pathname === '/vnc') bridgeVnc(ws, deps.cfg.vncSocket);
      else void bridgeTerminal(ws, deps);
    });
  });
  return wss;
}
