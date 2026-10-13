import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WorkerConfig } from '../src/config';
import { createDatabase, runMigrations, type Database } from '../src/db/client';
import { logger } from '../src/lib/logger';
import type { ComputerClient } from '../src/services/computer-client';
import type { Ctx } from '../src/services/context';
import { PushSender } from '../src/services/push';
import type { QueryFn, WorkerDeps } from '../src/worker/deps';

const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';
const MIGRATIONS = new URL('../drizzle', import.meta.url).pathname;

export async function databaseAvailable(): Promise<boolean> {
  const sql = postgres(BASE_URL, { max: 1, connect_timeout: 3, onnotice: () => undefined });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

export interface TestDb {
  url: string;
  database: Database;
  ctx: Ctx;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `ant_test_${randomBytes(5).toString('hex')}`;
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  await runMigrations(url.toString(), MIGRATIONS);
  const database = createDatabase(url.toString(), 5);
  return {
    url: url.toString(),
    database,
    ctx: { db: database.db, sql: database.sql },
    async drop() {
      await database.close();
      const a = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: 'unused',
    MIGRATIONS_DIR: MIGRATIONS,
    COMPUTER_URL: 'http://computer.test:7000',
    COMPUTER_RPC_TOKEN: 'test-computer-token-0123456789',
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: 'mailto:test@example.com',
    PUBLIC_ORIGIN: 'https://ant.test',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-subscription-token-for-tests',
    ANTHROPIC_API_KEY: 'sk-ant-api03-api-key-for-tests',
    CLAUDE_CONFIG_DIR: '/tmp/ant-test-claude',
    AGENT_CWD: '/tmp/ant-test-cwd',
    WORKER_ID: 'test-worker',
    CLAUDE_CODE_EXECUTABLE: undefined,
    ...overrides,
  };
}

export interface RecordedCall {
  prompt: string;
  options: Record<string, unknown> & { env?: Record<string, string>; resume?: string; hooks?: Record<string, { hooks: ((...a: unknown[]) => Promise<unknown>)[] }[]> };
}

/** Builds a fake Agent SDK `query` from a script producing SDK messages for each call. */
export function fakeQuery(script: (call: RecordedCall, index: number) => AsyncGenerator<SDKMessage>): { query: QueryFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const query = ((params: { prompt: string; options: RecordedCall['options'] }) => {
    const call = { prompt: params.prompt, options: params.options };
    calls.push(call);
    return script(call, calls.length - 1);
  }) as unknown as QueryFn;
  return { query, calls };
}

export function stubComputer(overrides: Partial<Record<keyof ComputerClient, unknown>> = {}): ComputerClient {
  return {
    configured: true,
    health: async () => ({ ok: true, display: true, browser: true, url: null }),
    exec: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, truncated: false, durationMs: 5 }),
    readFile: async () => ({ path: '/workspace/a', content: '     1\thello', totalLines: 1, truncated: false, binary: false }),
    writeFile: async (req: { path: string; content: string }) => ({ path: req.path, size: req.content.length }),
    editFile: async (req: { path: string }) => ({ path: req.path, replacements: 1 }),
    listFiles: async () => [],
    browser: async () => ({ ok: true, url: 'https://example.org/', title: 'Example' }),
    // Like the computer service: an element found gets a pin, replayed by an approved action.
    inspect: async () => ({ url: 'https://example.org/', title: 'Example', elementLabel: 'Envoyer', pin: '4d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a' }),
    download: async () => new Response('x'),
    wsUrl: () => 'ws://computer.test:7000/vnc',
    authHeader: 'Bearer test',
    ...overrides,
  } as unknown as ComputerClient;
}

export function workerDeps(ctx: Ctx, query: QueryFn, opts: { cfg?: Partial<WorkerConfig>; computer?: ComputerClient } = {}): WorkerDeps {
  const cfg = workerConfig(opts.cfg);
  return {
    ctx,
    cfg,
    push: new PushSender(ctx, { subject: cfg.VAPID_SUBJECT }),
    computer: opts.computer ?? stubComputer(),
    log: logger,
    query,
  };
}

export const sdk = {
  init(sessionId = 'sess-1'): SDKMessage {
    return { type: 'system', subtype: 'init', session_id: sessionId, uuid: crypto.randomUUID(), apiKeySource: 'none', claude_code_version: 'test', cwd: '/', tools: [], mcp_servers: [], model: 'claude-sonnet-5-5', permissionMode: 'default', slash_commands: [], output_style: 'default' } as unknown as SDKMessage;
  },
  delta(text: string, sessionId = 'sess-1'): SDKMessage {
    return { type: 'stream_event', parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID(), event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } } as unknown as SDKMessage;
  },
  assistant(text: string, sessionId = 'sess-1', error?: string): SDKMessage {
    return {
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: crypto.randomUUID(),
      ...(error ? { error } : {}),
      message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: text ? [{ type: 'text', text }] : [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 } },
    } as unknown as SDKMessage;
  },
  rateLimit(status: 'allowed' | 'allowed_warning' | 'rejected', extra: Record<string, unknown> = {}, sessionId = 'sess-1'): SDKMessage {
    return { type: 'rate_limit_event', session_id: sessionId, uuid: crypto.randomUUID(), rate_limit_info: { status, ...extra } } as unknown as SDKMessage;
  },
  result(text: string, cost: number, model = 'claude-sonnet-5-5', sessionId = 'sess-1', structured?: unknown): SDKMessage {
    return {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: sessionId,
      uuid: crypto.randomUUID(),
      duration_ms: 10,
      duration_api_ms: 10,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: cost,
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 },
      modelUsage: { [model]: { inputTokens: 1200, outputTokens: 80, cacheReadInputTokens: 9000, cacheCreationInputTokens: 300, webSearchRequests: 0, costUSD: cost, contextWindow: 1_000_000, maxOutputTokens: 128_000 } },
      permission_denials: [],
      ...(structured !== undefined ? { structured_output: structured } : {}),
    } as unknown as SDKMessage;
  },
};
