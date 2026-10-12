import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createComputerServer } from '../src/server';
import { parseResize, type PtyLike, type SpawnPty } from '../src/ws';
import { auth, close, listen, tempDir, testConfig, TOKEN } from './helpers';

describe('parseResize', () => {
  it('parses and clamps resize messages, ignores anything else', () => {
    expect(parseResize('{"type":"resize","cols":100,"rows":40}')).toEqual({ type: 'resize', cols: 100, rows: 40 });
    expect(parseResize('{"type":"resize","cols":0,"rows":99999}')).toEqual({ type: 'resize', cols: 1, rows: 500 });
    expect(parseResize('ls -la\r')).toBeNull();
    expect(parseResize('{"type":"other"}')).toBeNull();
    expect(parseResize('{"type":"resize"')).toBeNull();
  });
});

class FakePty implements PtyLike {
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  private dataCb: (d: string) => void = () => undefined;
  private exitCb: (e: { exitCode: number }) => void = () => undefined;
  constructor(public file: string, public args: string[], public opts: { cwd: string; env: Record<string, string> }) {}
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }
  write(d: string): void {
    this.written.push(d);
    this.dataCb(`echo:${d}`);
  }
  resize(c: number, r: number): void {
    this.resizes.push([c, r]);
  }
  kill(): void {
    this.killed = true;
  }
  exit(): void {
    this.exitCb({ exitCode: 0 });
  }
}

describe('WebSocket bridges', () => {
  let server: Server;
  let base: string;
  let vnc: TcpServer;
  let cleanup: () => Promise<void>;
  const ptys: FakePty[] = [];
  const vncReceived: Buffer[] = [];

  beforeAll(async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    // Fake RFB server: greets, then echoes uppercase.
    vnc = createTcpServer((sock) => {
      sock.write('RFB 003.008\n');
      sock.on('data', (d) => {
        vncReceived.push(d);
        sock.write(Buffer.from(d.toString('latin1').toUpperCase(), 'latin1'));
      });
    });
    await new Promise<void>((r) => vnc.listen(0, '127.0.0.1', r));
    const vncPort = (vnc.address() as AddressInfo).port;
    const spawnPty: SpawnPty = (file, args, opts) => {
      const p = new FakePty(file, args, opts);
      ptys.push(p);
      return p;
    };
    server = createComputerServer({ cfg: testConfig(t.dir, { vncPort }), ws: { spawnPty } });
    base = (await listen(server)).replace('http', 'ws');
  });
  afterAll(async () => {
    await close(server);
    await new Promise<void>((r) => vnc.close(() => r()));
    await cleanup();
  });

  it('bridges /vnc binary frames to the TCP VNC server', async () => {
    const ws = new WebSocket(`${base}/vnc`, { headers: auth });
    const frames: Buffer[] = [];
    ws.on('message', (d) => frames.push(d as Buffer));
    await new Promise((r) => ws.once('open', r));
    await expect.poll(() => Buffer.concat(frames).toString()).toBe('RFB 003.008\n');
    ws.send(Buffer.from('hello'));
    await expect.poll(() => Buffer.concat(frames).toString()).toBe('RFB 003.008\nHELLO');
    expect(Buffer.concat(vncReceived).toString()).toBe('hello');
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.close();
    expect(await closed).toBe(1005);
  });

  it('closes /vnc when the VNC server is unreachable', async () => {
    const t = await tempDir();
    const s = createComputerServer({ cfg: testConfig(t.dir, { vncPort: 1 }) });
    const b = (await listen(s)).replace('http', 'ws');
    const ws = new WebSocket(`${b}/vnc`, { headers: auth });
    const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)));
    expect(code).toBe(1011);
    await close(s);
    await t.cleanup();
  });

  it('/terminal: input, resize, output, minimal env, kill on close', async () => {
    const ws = new WebSocket(`${base}/terminal`, { headers: auth });
    const out: string[] = [];
    ws.on('message', (d) => out.push(d.toString()));
    await new Promise((r) => ws.once('open', r));
    await expect.poll(() => ptys.length).toBe(1);
    const pty = ptys[0]!;
    expect(['tmux', 'bash'].some((b) => pty.file.endsWith(b))).toBe(true);
    if (pty.file.endsWith('tmux')) expect(pty.args).toEqual(['new-session', '-A', '-s', 'ant']);
    expect(Object.values(pty.opts.env)).not.toContain(TOKEN);
    expect(pty.opts.env.HOME).toBe('/home/agent');

    ws.send('ls\r');
    ws.send('{"type":"resize","cols":90,"rows":30}');
    await expect.poll(() => out.join('')).toBe('echo:ls\r');
    expect(pty.resizes).toEqual([[90, 30]]);
    ws.close();
    await expect.poll(() => pty.killed).toBe(true);
  });

  it('/terminal closes the socket when the shell exits', async () => {
    const ws = new WebSocket(`${base}/terminal`, { headers: auth });
    await new Promise((r) => ws.once('open', r));
    await expect.poll(() => ptys.length).toBe(2);
    const closed = new Promise<number>((r) => ws.once('close', (c) => r(c)));
    ptys[1]!.exit();
    expect(await closed).toBe(1000);
  });
});

describe('node-pty', () => {
  it('spawns a real pty (native module loads)', async () => {
    const pty = await import('node-pty');
    const p = pty.spawn('bash', ['--norc', '--noprofile', '-c', 'echo pty-ok'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' } });
    let out = '';
    p.onData((d) => (out += d));
    await new Promise<void>((r) => p.onExit(() => r()));
    expect(out).toContain('pty-ok');
  });
});
