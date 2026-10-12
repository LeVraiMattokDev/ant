import type { AppSettings, BotPermissions, ComputeSource } from '@ant/shared';
import type { BotRow } from '../services/bots';
import type { ChannelRow } from '../services/channels';
import type { RunRow } from '../services/runs';
import type { WorkerDeps } from './deps';

/** State shared by the tools and hooks of one agent run. */
export interface RunContext {
  deps: WorkerDeps;
  settings: AppSettings;
  run: RunRow;
  bot: BotRow;
  permissions: BotPermissions;
  channel: ChannelRow | null;
  computeSource: ComputeSource;
  /** Approvals created during this run. */
  pendingApprovals: string[];
  /** Slugs → ids of all active bots (for mentions and hand-offs). */
  botsBySlug: Map<string, { id: string; name: string; role: string }>;
  /** Updates the « Dev utilise le navigateur… » indicator. */
  setActivity(activity: string | null): Promise<void>;
}
