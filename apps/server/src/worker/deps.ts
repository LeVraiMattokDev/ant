import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { WorkerConfig } from '../config';
import type { Logger } from '../lib/logger';
import type { ComputerClient } from '../services/computer-client';
import type { Ctx } from '../services/context';
import type { PushSender } from '../services/push';

export type QueryFn = typeof sdkQuery;

/** Everything the worker modules need; `query` is injectable for tests. */
export interface WorkerDeps {
  ctx: Ctx;
  cfg: WorkerConfig;
  push: PushSender;
  computer: ComputerClient;
  log: Logger;
  query: QueryFn;
}
