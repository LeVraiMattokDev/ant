import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { loadConfig, type Config } from '../src/config';

export const TOKEN = 'test-token-0123456789abcdefghij';

export async function tempDir(prefix = 'ant-computer-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function testConfig(workspaceRoot: string, overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      COMPUTER_RPC_TOKEN: TOKEN,
      WORKSPACE_ROOT: workspaceRoot,
      BROWSER_HEADLESS: '1',
    }),
    ...overrides,
  };
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export const auth = { authorization: `Bearer ${TOKEN}` };

export async function post<T = unknown>(base: string, route: string, body: unknown, headers: Record<string, string> = auth): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}
