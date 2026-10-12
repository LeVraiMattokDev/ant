import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { ExecRequest, ExecResponse } from '@ant/shared';
import { agentEnv, type Config } from './config';
import { badRequest } from './errors';
import { resolveWorkspacePath } from './paths';

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 1800;
/** Delay between SIGTERM and SIGKILL of the process group on timeout. */
export const KILL_GRACE_MS = 5_000;
/**
 * Once bash has exited, how long to keep reading pipes still held open by background children
 * (`server &`) before answering anyway. The children keep running.
 */
export const PIPE_DRAIN_MS = 1_000;

/**
 * Bounded output capture: keeps the HEAD (first half of the budget) and the TAIL (last half).
 * The beginning of an output (what ran) and its end (the error, the result) are what matter;
 * the middle is replaced by a French marker giving the number of dropped bytes.
 */
export class OutputCollector {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer[] = [];
  private tailSize = 0;
  private total = 0;

  constructor(private readonly maxBytes: number) {
    this.headLimit = Math.ceil(maxBytes / 2);
    this.tailLimit = maxBytes - this.headLimit;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headSize < this.headLimit) {
      const take = Math.min(chunk.length, this.headLimit - this.headSize);
      this.head.push(chunk.subarray(0, take));
      this.headSize += take;
      chunk = chunk.subarray(take);
    }
    if (chunk.length === 0 || this.tailLimit === 0) return;
    this.tail.push(chunk);
    this.tailSize += chunk.length;
    while (this.tailSize > this.tailLimit && this.tail.length > 0) {
      const first = this.tail[0]!;
      const excess = this.tailSize - this.tailLimit;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailSize -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailSize -= excess;
      }
    }
  }

  get truncated(): boolean {
    return this.total > this.maxBytes;
  }

  get totalBytes(): number {
    return this.total;
  }

  toString(): string {
    const head = Buffer.concat(this.head);
    if (!this.truncated) return Buffer.concat([head, ...this.tail]).toString('utf8');
    let tail = Buffer.concat(this.tail);
    // Do not start the tail in the middle of a UTF-8 sequence (continuation bytes are 10xxxxxx).
    let skip = 0;
    while (skip < tail.length && skip < 3 && (tail[skip]! & 0xc0) === 0x80) skip++;
    tail = tail.subarray(skip);
    const dropped = this.total - head.length - tail.length;
    return `${head.toString('utf8')}\n\n[… ${dropped} octets tronqués (sortie de ${this.total} octets, limite ${this.maxBytes}) …]\n\n${tail.toString('utf8')}`;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

export async function runCommand(cfg: Config, req: ExecRequest): Promise<ExecResponse> {
  const cwd = await resolveWorkspacePath(cfg.workspaceRoot, req.cwd);
  const st = await stat(cwd.abs).catch(() => null);
  if (!st?.isDirectory()) throw badRequest(`Dossier de travail introuvable : « ${req.cwd ?? ''} ».`);

  const timeoutSec = Math.min(Math.max(req.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC);
  const started = performance.now();
  const stdout = new OutputCollector(cfg.maxOutputBytes);
  const stderr = new OutputCollector(cfg.maxOutputBytes);

  return new Promise<ExecResponse>((resolve) => {
    const child = spawn('bash', ['-lc', req.command], {
      cwd: cwd.abs,
      env: agentEnv(cfg),
      detached: true, // own process group → the whole tree can be killed
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let exitCode: number | null = null;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const finish = (spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (spawnError) stderr.push(Buffer.from(`\n[Impossible de lancer la commande : ${spawnError.message}]\n`));
      resolve({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Math.round(performance.now() - started),
      });
    };

    child.stdout?.on('data', (c: Buffer) => stdout.push(c));
    child.stderr?.on('data', (c: Buffer) => stderr.push(c));
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      exitCode = code; // null when killed by a signal
      timers.push(setTimeout(() => finish(), timedOut ? 0 : PIPE_DRAIN_MS));
    });
    child.on('close', () => finish());

    timers.push(
      setTimeout(() => {
        if (child.pid === undefined) return;
        timedOut = true;
        const pid = child.pid;
        killGroup(pid, 'SIGTERM');
        // Not cleared by finish(): even if bash answers SIGTERM, children that ignore it get SIGKILL.
        setTimeout(() => {
          killGroup(pid, 'SIGKILL');
          // Last resort: answer even if something still holds the pipes.
          setTimeout(() => finish(), 2_000).unref();
        }, KILL_GRACE_MS).unref();
      }, timeoutSec * 1000),
    );
  });
}
