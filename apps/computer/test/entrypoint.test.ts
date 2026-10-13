import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_VNC_SOCKET } from '../src/config';
import { tempDir } from './helpers';

const ENTRYPOINT = fileURLToPath(new URL('../entrypoint.sh', import.meta.url));
const PATH = '/usr/local/bin:/usr/bin:/bin';

function hasBinary(bin: string): boolean {
  return PATH.split(':').some((dir) => {
    try {
      accessSync(path.join(dir, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** A display number nobody uses on this machine (no lock file, no socket). */
function freeDisplay(): number {
  for (let n = 140 + Math.floor(Math.random() * 40); n < 400; n++) {
    if (!existsSync(`/tmp/.X${n}-lock`) && !existsSync(`/tmp/.X11-unix/X${n}`)) return n;
  }
  throw new Error('aucun écran libre');
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

/** Inodes of the sockets a process holds open. */
function socketInodes(pid: number): Set<string> {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (m) inodes.add(m[1]!);
    } catch {
      // fd closed meanwhile
    }
  }
  return inodes;
}

/** Inodes of every listening TCP socket (IPv4 and IPv6) of this network namespace. */
function tcpListenInodes(): Set<string> {
  const inodes = new Set<string>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === '0A' && cols[9]) inodes.add(cols[9]); // 0A = LISTEN
    }
  }
  return inodes;
}

function findProcess(match: (cmdline: string[]) => boolean): number | null {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (match(cmdline)) return Number(entry);
    } catch {
      // process gone
    }
  }
  return null;
}

function stop(child: ChildProcess | undefined, group: boolean): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  try {
    if (group) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    // already gone
  }
  return exited;
}

// Text only, no binary needed: runs everywhere, so a drift that would break the live view is caught.
describe('entrypoint.sh : configuration', () => {
  it('defaults to the socket the Node bridge uses', () => {
    expect(readFileSync(ENTRYPOINT, 'utf8')).toContain(`VNC_SOCKET="\${VNC_SOCKET:-${DEFAULT_VNC_SOCKET}}"`);
  });
});

describe('entrypoint.sh : dossier personnel', () => {
  it('puts back the /etc/skel files hidden by the tmpfs, without replacing those already there', async () => {
    const t = await tempDir();
    try {
      const skel = path.join(t.dir, 'skel');
      const home = path.join(t.dir, 'home');
      mkdirSync(skel);
      mkdirSync(home);
      writeFileSync(path.join(skel, '.bashrc'), 'alias ll="ls -l"\n');
      writeFileSync(path.join(skel, '.profile'), '. ~/.bashrc\n');
      writeFileSync(path.join(home, '.profile'), 'déjà là\n');
      const res = spawnSync('bash', ['-c', 'source "$1"; seed_home', 'entrypoint-test', ENTRYPOINT], {
        env: { PATH, HOME: home, SKEL_DIR: skel },
        encoding: 'utf8',
      });
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe('alias ll="ls -l"\n');
      expect(readFileSync(path.join(home, '.profile'), 'utf8')).toBe('déjà là\n');
    } finally {
      await t.cleanup();
    }
  });

  it('does nothing when there is no skeleton', async () => {
    const t = await tempDir();
    try {
      const res = spawnSync('bash', ['-c', 'source "$1"; seed_home', 'entrypoint-test', ENTRYPOINT], {
        env: { PATH, HOME: t.dir, SKEL_DIR: path.join(t.dir, 'absent') },
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(readdirSync(t.dir)).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});

describe.skipIf(!hasBinary('x11vnc') || !hasBinary('Xvfb'))('entrypoint.sh : x11vnc', () => {
  let xvfb: ChildProcess | undefined;
  let vnc: ChildProcess | undefined;
  let vncLog = '';
  let display = '';
  let socketDir = '';
  let socketPath = '';
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const n = freeDisplay();
    display = `:${n}`;
    xvfb = spawn('Xvfb', [display, '-screen', '0', '640x480x24', '-nolisten', 'tcp'], { stdio: 'ignore', env: { PATH } });
    if (!(await waitFor(() => existsSync(`/tmp/.X11-unix/X${n}`), 10_000))) throw new Error("Xvfb n'a pas démarré");
    socketDir = path.join(t.dir, 'vnc');
    socketPath = path.join(socketDir, 'vnc.sock');
    // The real run_x11vnc function of the entrypoint (sourced: its main part does not run).
    vnc = spawn('bash', ['-c', 'source "$1"; run_x11vnc', 'entrypoint-test', ENTRYPOINT], {
      env: { PATH, HOME: t.dir, DISPLAY: display, VNC_SOCKET: socketPath },
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    vnc.stderr?.on('data', (d: Buffer) => (vncLog += d.toString()));
  }, 20_000);

  afterAll(async () => {
    await stop(vnc, true);
    await stop(xvfb, false);
    await cleanup?.();
  });

  it('serves RFB on a unix socket in a 0700 directory and listens on no TCP port', async () => {
    const up = await waitFor(() => existsSync(socketPath), 15_000);
    expect(up, `x11vnc n'a pas créé ${socketPath}. Journal : ${vncLog}`).toBe(true);
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketDir).mode & 0o777).toBe(0o700);

    const greeting = await new Promise<string>((resolve, reject) => {
      const sock = connect({ path: socketPath });
      sock.once('data', (d) => {
        resolve(d.toString('latin1'));
        sock.destroy();
      });
      sock.once('error', reject);
    });
    expect(greeting).toMatch(/^RFB 003\.\d{3}\n$/);

    // A page in Chromium (same network namespace) can only reach TCP: x11vnc must hold no TCP listener.
    const pid = findProcess((c) => c[0]?.endsWith('x11vnc') === true && c.includes(socketPath));
    expect(pid).not.toBeNull();
    const own = socketInodes(pid!);
    expect(own.size).toBeGreaterThan(0);
    const listening = tcpListenInodes();
    expect([...own].filter((inode) => listening.has(inode))).toEqual([]);
  }, 30_000);
});
