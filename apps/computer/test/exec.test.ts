import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import { OutputCollector, runCommand } from '../src/exec';
import { PathError } from '../src/paths';
import { tempDir, testConfig, TOKEN } from './helpers';

let cfg: Config;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  cfg = testConfig(t.dir, { maxOutputBytes: 1000 });
  await mkdir(path.join(t.dir, 'sub'));
  process.env.COMPUTER_RPC_TOKEN = TOKEN; // must not reach the command
});
afterAll(async () => {
  delete process.env.COMPUTER_RPC_TOKEN;
  await cleanup();
});

describe('OutputCollector', () => {
  it('keeps everything under the limit', () => {
    const c = new OutputCollector(10);
    c.push(Buffer.from('hello'));
    c.push(Buffer.from('world'));
    expect(c.truncated).toBe(false);
    expect(c.toString()).toBe('helloworld');
  });
  it('keeps head and tail with a marker when over the limit', () => {
    const c = new OutputCollector(10);
    for (const part of ['AAAA', 'ABBB', 'BBBB', 'CCCC', 'CDDD', 'DDDE']) c.push(Buffer.from(part));
    expect(c.truncated).toBe(true);
    expect(c.totalBytes).toBe(24);
    const out = c.toString();
    expect(out.startsWith('AAAAA')).toBe(true);
    expect(out.endsWith('DDDDE')).toBe(true);
    expect(out).toContain('14 octets tronqués');
  });
});

describe('runCommand', () => {
  it('runs a simple command in the workspace', async () => {
    const r = await runCommand(cfg, { command: 'echo hello; echo oops >&2; pwd; exit 3' });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe(`hello\n${cfg.workspaceRoot}\n`);
    expect(r.stderr).toBe('oops\n');
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('honours cwd inside the workspace and refuses escapes', async () => {
    const r = await runCommand(cfg, { command: 'pwd', cwd: 'sub' });
    expect(r.stdout.trim()).toBe(path.join(cfg.workspaceRoot, 'sub'));
    await expect(runCommand(cfg, { command: 'pwd', cwd: '../' })).rejects.toBeInstanceOf(PathError);
    await expect(runCommand(cfg, { command: 'pwd', cwd: 'missing' })).rejects.toThrow(/introuvable/);
  });

  it('uses a minimal environment that does not leak the token', async () => {
    const r = await runCommand({ ...cfg, maxOutputBytes: 1_000_000 }, { command: 'env; cat /proc/self/environ | tr "\\0" "\\n"' });
    expect(r.stdout).not.toContain(TOKEN);
    expect(r.stdout).not.toContain('COMPUTER_RPC_TOKEN');
    expect(r.stdout).toContain('HOME=/home/agent');
    expect(r.stdout).toContain('LANG=C.UTF-8');
    expect(r.stdout).toContain('TERM=xterm-256color');
    expect(r.stdout).toContain('DISPLAY=:99');
  });

  it('kills the whole process group on timeout', async () => {
    const marker = path.join(cfg.workspaceRoot, 'child-survived');
    const started = Date.now();
    const r = await runCommand(cfg, {
      command: `(sleep 3; touch ${marker}) & sleep 30`,
      timeoutSec: 1,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((res) => setTimeout(res, 3_500));
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
  });

  it('SIGKILLs processes that ignore SIGTERM', async () => {
    const r = await runCommand(cfg, { command: "trap '' TERM; while true; do sleep 0.2; done", timeoutSec: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(9_000);
  }, 15_000);

  it('truncates large outputs (head + tail)', async () => {
    const r = await runCommand(cfg, { command: 'echo START; seq 1 5000; echo END' });
    expect(r.truncated).toBe(true);
    expect(r.stdout.startsWith('START\n1\n2\n')).toBe(true);
    expect(r.stdout.trimEnd().endsWith('5000\nEND')).toBe(true);
    expect(r.stdout).toMatch(/octets tronqués/);
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(1200);
  });

  it('does not wait for background children holding the pipes', async () => {
    const r = await runCommand(cfg, { command: 'sleep 20 & echo started' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('started\n');
    expect(r.durationMs).toBeLessThan(5_000);
  });
});
