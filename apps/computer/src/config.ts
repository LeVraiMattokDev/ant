import path from 'node:path';

export interface Config {
  token: string;
  port: number;
  /** Absolute path of the shared workspace (the agents see it as /workspace). */
  workspaceRoot: string;
  browserProfileDir: string;
  /** Optional Chromium binary (otherwise the one installed by Playwright). */
  browserExecutablePath: string | undefined;
  display: string;
  vncPort: number;
  headless: boolean;
  maxOutputBytes: number;
  /** HOME given to commands, the terminal and Chromium. */
  agentHome: string;
}

export class ConfigError extends Error {}

export const MIN_TOKEN_LENGTH = 24;

function int(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} invalide : « ${raw} » (entier entre ${min} et ${max} attendu).`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.COMPUTER_RPC_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `COMPUTER_RPC_TOKEN manquant ou trop court (${MIN_TOKEN_LENGTH} caractères minimum) : refus de démarrer.`,
    );
  }
  const display = env.DISPLAY?.trim() || ':99';
  if (!/^:\d+(\.\d+)?$/.test(display)) throw new ConfigError(`DISPLAY invalide : « ${display} » (ex. « :99 »).`);
  return {
    token,
    port: int('PORT', env.PORT, 7000, 1, 65535),
    workspaceRoot: path.resolve(env.WORKSPACE_ROOT?.trim() || '/workspace'),
    browserProfileDir: path.resolve(env.BROWSER_PROFILE_DIR?.trim() || '/home/agent/.ant-browser'),
    browserExecutablePath: env.BROWSER_EXECUTABLE_PATH?.trim() || undefined,
    display,
    vncPort: int('VNC_PORT', env.VNC_PORT, 5900, 1, 65535),
    headless: env.BROWSER_HEADLESS === '1' || env.BROWSER_HEADLESS === 'true',
    maxOutputBytes: int('MAX_OUTPUT_BYTES', env.MAX_OUTPUT_BYTES, 100_000, 1_000, 50_000_000),
    agentHome: '/home/agent',
  };
}

/** X11 socket of the configured display (":99" → "/tmp/.X11-unix/X99"). */
export function displaySocket(display: string): string {
  const num = display.replace(/^:/, '').split('.')[0] ?? '99';
  return `/tmp/.X11-unix/X${num}`;
}

export const DEFAULT_PATH = '/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Minimal environment for everything the agents can run (commands, terminal, Chromium).
 * Never derived from the service's own environment: COMPUTER_RPC_TOKEN must not leak.
 */
export function agentEnv(cfg: Pick<Config, 'agentHome' | 'display'>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: DEFAULT_PATH,
    HOME: cfg.agentHome,
    LANG: 'C.UTF-8',
    DISPLAY: cfg.display,
    TERM: 'xterm-256color',
    ...extra,
  };
}
