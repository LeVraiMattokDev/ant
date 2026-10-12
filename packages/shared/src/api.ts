/**
 * Contract between the server (`apps/server`) and the UI (`apps/ui`):
 * DTOs returned by the REST API and events pushed over the WebSocket.
 */
import type { ComputeMode, ComputeSource, QuotaThresholds, RunPriority } from './quota';
import type { EffortLevel, SubagentTier } from './models';
import type { ApprovalCategory } from './risk';
import type { AppSettings } from './settings';
import type { TimeRange } from './time';

export type ISODate = string;

// ───────────────────────────── Auth ─────────────────────────────

export interface AuthStateDTO {
  setupRequired: boolean;
  authenticated: boolean;
  /** Password accepted, waiting for TOTP / recovery code. */
  secondFactorPending: boolean;
  /** Password set during setup, waiting for TOTP enrolment. */
  enrolmentPending: boolean;
  hasPasskey: boolean;
}

export interface SetupStartResponse {
  totpSecret: string;
  totpUri: string;
}

export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

export interface PasskeyDTO {
  id: string;
  name: string;
  createdAt: ISODate;
  lastUsedAt: ISODate | null;
}

export interface AuthSessionDTO {
  id: string;
  current: boolean;
  createdAt: ISODate;
  lastSeenAt: ISODate;
  expiresAt: ISODate;
  ip: string | null;
  userAgent: string | null;
}

// ───────────────────────────── Bots ─────────────────────────────

export interface BotPermissions {
  /** Shell commands on the agents' computer. */
  terminal: boolean;
  /** Chromium on the agents' computer. */
  browser: boolean;
  /** Read/write files in /workspace. */
  files: boolean;
  webSearch: boolean;
  /** Write to the shared memory (own memory is always writable). */
  sharedMemoryWrite: boolean;
  /** Hand tasks to other bots / mention them. */
  handoff: boolean;
  lightSubagent: boolean;
  expertSubagent: boolean;
}

export const DEFAULT_BOT_PERMISSIONS: BotPermissions = {
  terminal: true,
  browser: true,
  files: true,
  webSearch: true,
  sharedMemoryWrite: false,
  handoff: true,
  lightSubagent: true,
  expertSubagent: true,
};

export interface BotDTO {
  id: string;
  slug: string;
  name: string;
  avatar: string;
  role: string;
  instructions: string;
  model: string;
  effort: EffortLevel;
  permissions: BotPermissions;
  heartbeatEnabled: boolean;
  heartbeatIntervalMin: number;
  quietHours: TimeRange | null;
  apiDailyCapUsd: number | null;
  paused: boolean;
  dmChannelId: string;
  /** Current activity, null when idle. */
  activity: string | null;
  createdAt: ISODate;
}

export interface BotInput {
  name: string;
  slug?: string;
  avatar?: string;
  role: string;
  instructions?: string;
  model?: string;
  effort?: EffortLevel;
  permissions?: Partial<BotPermissions>;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMin?: number;
  quietHours?: TimeRange | null;
  apiDailyCapUsd?: number | null;
  paused?: boolean;
}

// ─────────────────────────── Channels ───────────────────────────

export type ChannelKind = 'dm' | 'group';

export interface ChannelDTO {
  id: string;
  kind: ChannelKind;
  name: string;
  topic: string;
  botIds: string[];
  dmBotId: string | null;
  lastMessageAt: ISODate | null;
  /** Latest top-level message, for the conversation list preview. */
  lastMessage: { content: string; authorKind: AuthorKind; botId: string | null; createdAt: ISODate } | null;
  createdAt: ISODate;
}

export interface ChannelInput {
  name: string;
  topic?: string;
  botIds: string[];
}

export type AuthorKind = 'user' | 'bot' | 'system';
export type MessageStatus = 'streaming' | 'done' | 'error';

export type MessageKind =
  | 'chat'
  | 'nudge'
  | 'digest'
  | 'routine'
  | 'handoff'
  | 'delegation'
  | 'approval'
  | 'compute_switch'
  | 'tool'
  | 'error'
  | 'info';

export interface MessageMeta {
  kind?: MessageKind;
  runId?: string;
  model?: string;
  effort?: EffortLevel;
  computeSource?: ComputeSource;
  costUsd?: number;
  approvalId?: string;
  nudgeId?: string;
  routineId?: string;
  subagent?: { tier: SubagentTier | 'autre'; model: string; effort: string | null; reason: string };
  handoff?: { fromBotId: string; toBotId: string };
  tool?: { name: string; summary: string };
}

export interface MessageDTO {
  id: string;
  channelId: string;
  threadRootId: string | null;
  authorKind: AuthorKind;
  botId: string | null;
  content: string;
  meta: MessageMeta;
  status: MessageStatus;
  replyCount: number;
  lastReplyAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface PostMessageInput {
  content: string;
  threadRootId?: string | null;
}

export interface SearchResultDTO {
  message: MessageDTO;
  channelName: string;
  snippet: string;
}

// ───────────────────────────── Runs ─────────────────────────────

export type RunTrigger = 'user' | 'mention' | 'handoff' | 'heartbeat' | 'routine' | 'digest' | 'approval' | 'system';
export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'done' | 'error' | 'cancelled' | 'paused';

export interface RunDTO {
  id: string;
  botId: string;
  channelId: string | null;
  threadRootId: string | null;
  trigger: RunTrigger;
  priority: RunPriority;
  status: RunStatus;
  computeSource: ComputeSource | null;
  computeReason: string | null;
  model: string;
  effort: EffortLevel;
  activity: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  createdAt: ISODate;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

// ──────────────────────────── Memory ────────────────────────────

export type MemoryScope = 'shared' | 'bot';
export const MEMORY_KINDS = ['profil', 'preference', 'projet', 'fait', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryItemDTO {
  id: string;
  scope: MemoryScope;
  botId: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  importance: number;
  authorKind: 'user' | 'bot';
  authorBotId: string | null;
  sourceMessageId: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface MemoryInput {
  scope: MemoryScope;
  botId?: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  tags?: string[];
  pinned?: boolean;
  importance?: number;
}

// ───────────────────────────── Tasks ────────────────────────────

export type TaskStatus = 'open' | 'waiting' | 'done' | 'dropped';

export interface TaskDTO {
  id: string;
  botId: string;
  title: string;
  details: string;
  status: TaskStatus;
  dueAt: ISODate | null;
  sourceMessageId: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ──────────────────────────── Nudges ────────────────────────────

export const NUDGE_KINDS = ['idee', 'risque', 'oubli', 'etape', 'opportunite'] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];
export type NudgeStatus = 'delivered' | 'deferred' | 'dismissed' | 'acted';

export interface NudgeDTO {
  id: string;
  botId: string;
  kind: NudgeKind;
  title: string;
  content: string;
  status: NudgeStatus;
  messageId: string | null;
  createdAt: ISODate;
}

// ─────────────────────────── Routines ───────────────────────────

export interface RoutineDTO {
  id: string;
  botId: string;
  channelId: string;
  sourceText: string;
  cron: string;
  timezone: string;
  description: string;
  instruction: string;
  urgent: boolean;
  enabled: boolean;
  lastRunAt: ISODate | null;
  nextRuns: ISODate[];
  createdAt: ISODate;
}

export interface RoutineParseInput {
  text: string;
  botId: string;
}

export interface RoutineDraftDTO {
  cron: string;
  timezone: string;
  instruction: string;
  urgent: boolean;
  description: string;
  nextRuns: ISODate[];
}

export interface RoutineInput {
  botId: string;
  channelId?: string | null;
  sourceText: string;
  cron: string;
  timezone?: string;
  instruction: string;
  urgent?: boolean;
  enabled?: boolean;
}

// ─────────────────────────── Approvals ──────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'failed';

export interface ApprovalDTO {
  id: string;
  runId: string | null;
  botId: string;
  channelId: string | null;
  category: ApprovalCategory;
  tool: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  hasScreenshot: boolean;
  urgent: boolean;
  status: ApprovalStatus;
  comment: string | null;
  result: string | null;
  createdAt: ISODate;
  decidedAt: ISODate | null;
  expiresAt: ISODate;
}

export interface ApprovalDecisionInput {
  decision: 'approve' | 'reject';
  comment?: string;
}

// ──────────────────────────── Quota ─────────────────────────────

export type SubscriptionHealth = 'ok' | 'warning' | 'limited' | 'unknown' | 'not_configured' | 'auth_failed';

export interface UsageWindowDTO {
  utilization: number | null;
  resetsAt: ISODate | null;
}

export interface QuotaStatusDTO {
  mode: ComputeMode;
  thresholds: QuotaThresholds;
  subscription: {
    configured: boolean;
    health: SubscriptionHealth;
    limitedUntil: ISODate | null;
    fiveHour: UsageWindowDTO;
    sevenDay: UsageWindowDTO;
    lastEventAt: ISODate | null;
    tokenCreatedAt: ISODate | null;
    tokenExpiresAt: ISODate | null;
    /** Tokens consumed by Ant on the subscription today (all models). */
    antTokensToday: number;
    /** API-equivalent value of what Ant consumed on the subscription today (estimate). */
    antEquivalentUsdToday: number;
  };
  api: {
    configured: boolean;
    authFailed: boolean;
    spentTodayUsd: number;
    spentMonthUsd: number;
    dailyCapUsd: number;
    monthlyCapUsd: number;
  };
  /** True when no source can run work right now. */
  allPaused: boolean;
  pausedReason: string | null;
}

export interface UsageRowDTO {
  day: string;
  botId: string | null;
  model: string;
  computeSource: ComputeSource;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  runs: number;
}

// ──────────────────────────── Audit ─────────────────────────────

export interface AuditEntryDTO {
  id: number;
  at: ISODate;
  actor: string;
  event: string;
  runId: string | null;
  tool: string | null;
  detail: unknown;
  outcome: string | null;
  ip: string | null;
}

// ─────────────────────────── Computer ───────────────────────────

export type ComputerHolder = 'agents' | 'user';

export interface ComputerStatusDTO {
  online: boolean;
  holder: ComputerHolder;
  since: ISODate;
  activeBotId: string | null;
  lastAction: string | null;
  url: string | null;
}

export interface FileEntryDTO {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modifiedAt: ISODate;
}

// ─────────────────────────── Settings ───────────────────────────

export type SettingsDTO = AppSettings;

export interface PushPublicKeyDTO {
  publicKey: string | null;
}

// ─────────────────────────── WebSocket ──────────────────────────

export type ServerEvent =
  | { type: 'message.created'; message: MessageDTO }
  | { type: 'message.updated'; message: MessageDTO }
  | { type: 'message.delta'; messageId: string; channelId: string; delta: string }
  | { type: 'run.updated'; run: RunDTO }
  | { type: 'bot.updated'; botId: string }
  | { type: 'channel.updated'; channelId: string }
  | { type: 'approval.updated'; approval: ApprovalDTO }
  | { type: 'quota.updated' }
  | { type: 'memory.updated' }
  | { type: 'tasks.updated' }
  | { type: 'routines.updated' }
  | { type: 'nudge.created'; nudge: NudgeDTO }
  | { type: 'computer.updated'; status: ComputerStatusDTO }
  | { type: 'toast'; level: 'info' | 'warning' | 'error'; title: string; body: string; url?: string };

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
