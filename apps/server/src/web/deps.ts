import type { WebConfig } from '../config';
import type { ComputerClient } from '../services/computer-client';
import type { Ctx } from '../services/context';
import type { PushSender } from '../services/push';
import type { SessionConfig } from './session';

export interface WebDeps {
  ctx: Ctx;
  cfg: WebConfig;
  session: SessionConfig;
  push: PushSender;
  computer: ComputerClient;
  /** One-time setup token while no owner exists (null once set up). */
  setupToken: { value: string | null };
  rpID: string;
}
