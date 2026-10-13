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
 * (`server &`) before answering anyway. The children keep running: the pipes stay open and are
 * still read, but what they write after the answer is discarded.
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

/**
 * Module-level on purpose: a closure created inside runCommand would keep that run's whole scope
 * (captured output included) alive for as long as the pipe it is attached to stays open.
 */
const ignore = (): void => undefined;

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

    const onStdout = (c: Buffer): void => stdout.push(c);
    const onStderr = (c: Buffer): void => stderr.push(c);
    const onError = (err: Error): void => finish(err);
    const onExit = (code: number | null): void => {
      exitCode = code; // null when killed by a signal
      timers.push(setTimeout(() => finish(), timedOut ? 0 : PIPE_DRAIN_MS));
    };
    const onClose = (): void => finish();

    const finish = (spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (spawnError) stderr.push(Buffer.from(`\n[Impossible de lancer la commande : ${spawnError.message}]\n`));
      const response: ExecResponse = {
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Math.round(performance.now() - started),
      };
      // Never close the pipes: a background child that inherited them (`server &` without
      // redirection) would die of SIGPIPE/EPIPE on its next write. They stay open as long as it
      // runs (days for a dev server), so nothing of this run may stay attached to them or to the
      // child: every closure created here would keep the captured output (up to 2 × maxOutputBytes)
      // and the answer alive. Only module-level handlers remain: the pipes keep being drained into
      // the void, read errors stay harmless, and the event loop is not held open.
      for (const [pipe, onData] of [
        [child.stdout, onStdout],
        [child.stderr, onStderr],
      ] as const) {
        if (!pipe) continue;
        pipe.off('data', onData).on('data', ignore);
        (pipe as { unref?: () => void }).unref?.();
      }
      child.off('error', onError).off('exit', onExit).off('close', onClose).on('error', ignore);
      resolve(response);
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    // A read error must not crash the service (nor after the answer, while background children write).
    child.stdout?.on('error', ignore);
    child.stderr?.on('error', ignore);
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('close', onClose);

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
