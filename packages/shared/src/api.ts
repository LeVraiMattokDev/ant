/**
 * Contract between the server (`apps/server`) and the UI (`apps/ui`):
 * DTOs returned by the REST API and events pushed over the WebSocket.
 */
import type { ComputeMode, ComputeSource, QuotaThresholds, RunPriority } from './quota';
import type { EffortLevel, SubagentTier } from './models';
import type { ApprovalCategory } from './risk';
import type { AppSettings, EmergencyStopState } from './settings';
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

/** GET /api/system/network: what the web service sees of the connection, to set TRUST_PROXY to the proxy's exact address. */
export interface NetworkInfoDTO {
  /** Address of the peer that opened the TCP connection (Nginx Proxy Manager when Ant sits behind it). */
  peerAddress: string | null;
  /** Client address retained after applying TRUST_PROXY (used for throttling, sessions and the audit log). */
  clientIp: string;
  /** X-Forwarded-For header as received, if any. */
  forwardedFor: string | null;
  /** Current TRUST_PROXY value. */
  trustProxy: string;
  /** True when every hop is trusted ('true'): X-Forwarded-For can then be forged by any client. */
  trustAll: boolean;
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

/**
 * When a finished run sends a push to the owner (« <bot> a terminé ») while he is not looking at the conversation:
 * always, only for long runs (`completionPushMinSeconds`), or never. Global default in settings; bots and routines
 * can override it (null = inherit).
 */
export const COMPLETION_PUSH_MODES = ['always', 'long', 'never'] as const;
export type CompletionPushMode = (typeof COMPLETION_PUSH_MODES)[number];

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
  /** Completion push for this bot's runs; null = global setting `completionPush`. */
  completionPush: CompletionPushMode | null;
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
  completionPush?: CompletionPushMode | null;
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
  /** Owner's read mark, shared by all his devices (POST /api/channels/:id/read); null = never marked. */
  lastReadAt: ISODate | null;
  createdAt: ISODate;
}

/** POST /api/channels/:id/read. `at` defaults to now and is clamped to now; a mark never moves backwards. */
export interface ChannelReadInput {
  at?: ISODate;
}

export interface ChannelReadDTO {
  channelId: string;
  lastReadAt: ISODate;
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
  | 'info'
  /** A reminder (followup of kind `reminder`) posted without any model call. */
  | 'reminder'
  /** Card of an X draft (meta.draftId). */
  | 'draft'
  /** A bot's report after a page/RSS watch changed (meta.watchId). */
  | 'watch';

/**
 * A file attached to a message. Files live on the agents' computer: the owner's uploads under
 * `/workspace/inbox/AAAA-MM-JJ/<uuid>-<nom>`, the bots' files anywhere in /workspace. Downloaded through
 * GET /api/computer/files/download?path= (add `inline=1` for an image or PDF preview).
 */
export interface MessageAttachment {
  /** Absolute path on the computer, under /workspace. */
  path: string;
  /** File name shown to the owner. */
  name: string;
  /** MIME type detected from the extension (never trusted for inline display beyond the allowlist). */
  mime: string;
  size: number;
}

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
  /** Files attached by the owner (upload) or by a bot (attach tool). */
  attachments?: MessageAttachment[];
  followupId?: string;
  draftId?: string;
  watchId?: string;
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

/** One-off model for a single message (« Approfondir »): the bot's default model is left untouched. */
export const RUN_DEPTHS = ['rapide', 'expert'] as const;
export type RunDepth = (typeof RUN_DEPTHS)[number];

export interface PostMessageInput {
  content: string;
  threadRootId?: string | null;
  /** Paths returned by POST /api/channels/:id/attachments (under /workspace/inbox/). */
  attachments?: string[];
  /** Runs this message once on another model (see RUN_DEPTH_MODELS); absent = the bot's own model. */
  depth?: RunDepth;
}

export interface SearchResultDTO {
  message: MessageDTO;
  channelName: string;
  /** Excerpt of the message; matched words are wrapped in SEARCH_MARK_START … SEARCH_MARK_END. */
  snippet: string;
}

/**
 * Delimiters around matched words in `SearchResultDTO.snippet` (GET /api/search).
 * Control characters, so they never collide with message text such as French « guillemets ».
 */
export const SEARCH_MARK_START = '\u0002';
export const SEARCH_MARK_END = '\u0003';

// ───────────────────────────── Runs ─────────────────────────────

export type RunTrigger =
  | 'user'
  | 'mention'
  | 'handoff'
  | 'heartbeat'
  | 'routine'
  | 'digest'
  | 'approval'
  | 'system'
  /** A followup of kind `work` that a bot (or the owner) scheduled. */
  | 'followup'
  /** A page/RSS watch changed: the bot reads the diff (silent when it answers RIEN). */
  | 'watch'
  /** The owner edited or rejected an X draft: the bot learns from the change. */
  | 'draft';
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
  /** Message it comes from (« Mémoriser » in a message's menu); POST only. */
  sourceMessageId?: string | null;
}

// ───────────────────────────── Tasks ────────────────────────────

export type TaskStatus = 'open' | 'waiting' | 'done' | 'dropped';
/** `bot`: the bot's own to-do. `owner`: something the owner has to do, tracked by the bot (`botId`). */
export const TASK_ASSIGNEES = ['bot', 'owner'] as const;
export type TaskAssignee = (typeof TASK_ASSIGNEES)[number];

export interface TaskDTO {
  id: string;
  botId: string;
  assignee: TaskAssignee;
  title: string;
  details: string;
  status: TaskStatus;
  dueAt: ISODate | null;
  sourceMessageId: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** POST /api/tasks */
export interface TaskCreateInput {
  botId: string;
  title: string;
  details?: string;
  dueAt?: ISODate | null;
  assignee?: TaskAssignee;
  sourceMessageId?: string | null;
}

/** PATCH /api/tasks/:id (`botId` reassigns the task to another bot). */
export interface TaskPatchInput {
  title?: string;
  details?: string;
  status?: TaskStatus;
  dueAt?: ISODate | null;
  botId?: string;
  assignee?: TaskAssignee;
}

// ─────────────────────────── Followups ──────────────────────────

/** `reminder`: posts the text and sends a push, no model call. `work`: wakes the bot (run trigger `followup`). */
export const FOLLOWUP_KINDS = ['reminder', 'work'] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];
export type FollowupStatus = 'pending' | 'fired' | 'cancelled' | 'failed';
export type FollowupCreator = 'owner' | 'bot';

export interface FollowupDTO {
  id: string;
  kind: FollowupKind;
  /** Bot that posts the reminder or does the work; null = the owner's own reminder (push + system message). */
  botId: string | null;
  /** Conversation it is posted in; null = push only. */
  channelId: string | null;
  threadRootId: string | null;
  /** Task whose due date created it (one followup per task, moved with the due date). */
  taskId: string | null;
  runAt: ISODate;
  instruction: string;
  createdBy: FollowupCreator;
  status: FollowupStatus;
  firedAt: ISODate | null;
  /** Run started when a `work` followup fired. */
  runId: string | null;
  error: string | null;
  createdAt: ISODate;
}

/** POST /api/followups (owner). Bots use the followup_schedule tool. */
export interface FollowupInput {
  kind: FollowupKind;
  runAt: ISODate;
  instruction: string;
  botId?: string | null;
  channelId?: string | null;
  threadRootId?: string | null;
  taskId?: string | null;
}

/** PATCH /api/followups/:id (pending followups only). */
export interface FollowupPatchInput {
  runAt?: ISODate;
  instruction?: string;
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
  /** Proposed by a bot (routine_propose) and not yet enabled by the owner. Cleared when the owner enables it. */
  proposed: boolean;
  /** Completion push of this routine's runs; null = its bot's setting. */
  completionPush: CompletionPushMode | null;
  /** « Silencieux si rien » : no message is posted when the bot answers RIEN. */
  silentIfNothing: boolean;
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
  completionPush?: CompletionPushMode | null;
  silentIfNothing?: boolean;
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
  /** A domain grant (request_approval) withdrawn by the owner before its 30 minutes ran out. */
  revokedAt: ISODate | null;
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
    /**
     * Linear projection of the month's API spend: spent so far / days elapsed × days in the month, the days elapsed
     * counted at least 3 (an expensive first hour of the month does not project a whole month of it).
     */
    forecastMonthUsd: number;
  };
  /** True when no source can run work right now. */
  allPaused: boolean;
  pausedReason: string | null;
  /**
   * Liveness of the worker service, which runs the bots (heartbeat written about every 30 s).
   * Optional: a server that does not report it leaves the UI silent about the worker.
   */
  worker?: {
    lastSeenAt: ISODate | null;
    /** False when no heartbeat came for about 2 minutes (judged with the server's clock). */
    alive: boolean;
  };
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

/**
 * What a model call was for, recorded on each `run_model_usage` row (null on rows written before it existed:
 * shown as « non classé »). Runs record their trigger; one-shot calls their own purpose.
 */
export const USAGE_PURPOSES = [
  'user',
  'mention',
  'handoff',
  'approval',
  'heartbeat',
  'heartbeat_triage',
  'routine',
  'digest',
  'rotate',
  'routine_parse',
  'followup',
  'watch',
  'draft',
  'web_extract',
  'diagnostic',
  'system',
] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

export interface UsageByPurposeDTO {
  purpose: UsagePurpose | null;
  computeSource: ComputeSource;
  costUsd: number;
  tokens: number;
  runs: number;
}

export interface UsageByRoutineDTO {
  routineId: string;
  botId: string | null;
  costUsd: number;
  tokens: number;
  runs: number;
}

/** GET /api/quota/usage/origins?days=30 */
export interface UsageOriginsDTO {
  days: number;
  byPurpose: UsageByPurposeDTO[];
  /** Most expensive routines first (at most 10). */
  byRoutine: UsageByRoutineDTO[];
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

// ──────────────────────────── Health ────────────────────────────

/** Rows of `service_status`: liveness written by the worker, the backup service and the connection test. */
export const SERVICE_KEYS = ['worker', 'backup', 'diagnostic'] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

/** `service_status.detail` of the worker (written at start and on every scheduler pass, about every 30 s). */
export interface WorkerStatusDetail {
  workerId: string;
  startedAt: ISODate;
  subscriptionConfigured: boolean;
  apiConfigured: boolean;
  computerConfigured: boolean;
}

/** `service_status.detail` of the backup service (deploy/backup.sh writes it with psql after each attempt). */
export interface BackupStatusDetail {
  lastAttemptAt: ISODate | null;
  lastSuccessAt: ISODate | null;
  lastError: string | null;
  file: string | null;
  sizeBytes: number | null;
}

export type HealthLevel = 'ok' | 'warning' | 'error' | 'unknown';

export interface HealthJobKindDTO {
  kind: string;
  pending: number;
  running: number;
  /** Oldest due job still waiting. */
  oldestDueAt: ISODate | null;
  failed24h: number;
}

/** GET /api/system/health */
export interface SystemHealthDTO {
  checkedAt: ISODate;
  /** Version of the web service (package version + ANT_VERSION when set). */
  version: string;
  worker: { level: HealthLevel; lastSeenAt: ISODate | null; version: string | null; detail: WorkerStatusDetail | null };
  computer: { level: HealthLevel; configured: boolean; online: boolean; display: boolean; browser: boolean; url: string | null; error: string | null };
  database: { level: HealthLevel; sizeBytes: number; largestTables: { name: string; sizeBytes: number }[] };
  jobs: { level: HealthLevel; kinds: HealthJobKindDTO[]; failed24h: number };
  backup: { level: HealthLevel; lastSeenAt: ISODate | null; detail: BackupStatusDetail | null };
  push: { level: HealthLevel; configured: boolean; subscriptions: number; lastOkAt: ISODate | null };
  subscriptionToken: { level: HealthLevel; configured: boolean; createdAt: ISODate | null; expiresAt: ISODate | null; daysLeft: number | null };
  network: { trustProxy: string; trustAll: boolean };
  emergencyStop: EmergencyStopState | null;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

/** GET /api/system/jobs */
export interface JobDTO {
  id: string;
  kind: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  payload: Record<string, unknown>;
  runAt: ISODate;
  createdAt: ISODate;
  finishedAt: ISODate | null;
}

/** POST /api/system/emergency-stop */
export interface EmergencyStopInput {
  reason?: string;
}

/** POST /api/system/emergency-resume */
export interface EmergencyResumeDTO {
  resumedBotIds: string[];
}

export type DiagnosticOutcome = 'ok' | 'not_configured' | 'auth_failed' | 'rate_limited' | 'model_unavailable' | 'error';

export interface DiagnosticSourceDTO {
  source: ComputeSource;
  configured: boolean;
  outcome: DiagnosticOutcome;
  /** French, shown as is. */
  message: string;
  latencyMs: number | null;
  costUsd: number | null;
  /** First raw rate_limit_event received (to calibrate the unit of `utilization`). */
  rateLimitEvent: unknown;
}

/** GET/POST /api/system/diagnostic. Stored in `service_status` (key `diagnostic`). */
export interface DiagnosticDTO {
  status: 'idle' | 'pending' | 'done' | 'failed';
  requestedAt: ISODate | null;
  finishedAt: ISODate | null;
  results: DiagnosticSourceDTO[];
  error: string | null;
}

/** POST /api/bots/batch (onboarding: starter team). */
export interface BotBatchInput {
  bots: BotInput[];
  /** Optional group channel created with all these bots (e.g. « général »). */
  groupChannel?: { name: string; topic?: string } | null;
}

export interface BotBatchDTO {
  bots: BotDTO[];
  channel: ChannelDTO | null;
}

// ──────────────────────────── Drafts ────────────────────────────

export const DRAFT_KINDS = ['post', 'thread', 'reply'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export const DRAFT_STATUSES = ['draft', 'approved', 'scheduled', 'published', 'rejected'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export type DraftPlatform = 'x';

/** A post prepared by a bot and published by the owner himself (X web intent link): never automated. */
export interface DraftDTO {
  id: string;
  botId: string;
  channelId: string | null;
  threadRootId: string | null;
  /** Card message posted in the conversation (meta.kind 'draft'). */
  messageId: string | null;
  platform: DraftPlatform;
  kind: DraftKind;
  /** One part for a post or a reply, several for a thread. */
  parts: string[];
  replyToUrl: string | null;
  /** Images to attach by hand, under /workspace. */
  mediaPaths: string[];
  notes: string;
  status: DraftStatus;
  scheduledAt: ISODate | null;
  publishedUrl: string | null;
  publishedAt: ISODate | null;
  ownerFeedback: string | null;
  decidedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** PATCH /api/drafts/:id (owner edit, status draft|approved|scheduled). */
export interface DraftPatchInput {
  kind?: DraftKind;
  parts?: string[];
  replyToUrl?: string | null;
  mediaPaths?: string[];
  notes?: string;
}

/** POST /api/drafts/:id/decide */
export interface DraftDecisionInput {
  decision: 'approve' | 'schedule' | 'reject';
  /** Required with `schedule`. */
  scheduledAt?: ISODate;
  comment?: string;
}

/** POST /api/drafts/:id/published */
export interface DraftPublishedInput {
  url?: string | null;
}

// ──────────────────────────── Watches ───────────────────────────

export const WATCH_KINDS = ['page', 'rss', 'json'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
/**
 * `http`: curl inside the computer (no page state, no model). Rendering with Chromium (pages built in JavaScript) is
 * not offered in this round: the computer has one browser page, shared by the bots and the owner, and a background
 * check would navigate it away from under them (half-filled form, page an approval waits on). It needs an isolated
 * browsing context in the computer's RPC first.
 */
export const WATCH_RENDERS = ['http'] as const;
export type WatchRender = (typeof WATCH_RENDERS)[number];

/** A page or feed checked without any model call; the bot is woken (trigger `watch`) only when it changed. */
export interface WatchDTO {
  id: string;
  botId: string;
  channelId: string;
  url: string;
  kind: WatchKind;
  /** CSS selector (page) narrowing what is compared. */
  selector: string | null;
  render: WatchRender;
  intervalMin: number;
  /** What the bot should report when it changes. */
  instruction: string;
  enabled: boolean;
  /** Proposed by a bot (watch_propose), waiting for the owner. */
  proposed: boolean;
  lastCheckedAt: ISODate | null;
  lastChangedAt: ISODate | null;
  /** Unified diff (or new RSS items) of the last change, at most 8 KB. */
  lastDiff: string | null;
  lastError: string | null;
  nextCheckAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** POST /api/watches; PATCH takes Partial<WatchInput> without botId. */
export interface WatchInput {
  botId: string;
  /** null or absent = the bot's private conversation. */
  channelId?: string | null;
  url: string;
  kind?: WatchKind;
  selector?: string | null;
  render?: WatchRender;
  intervalMin?: number;
  instruction: string;
  enabled?: boolean;
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
  | {
      type: 'message.delta';
      messageId: string;
      channelId: string;
      delta: string;
      /**
       * Length of the message text before this chunk (UTF-16 units, like `String.length`). Lets the UI apply chunks
       * idempotently and notice a gap (e.g. text fetched from the database before the latest chunks were saved).
       * Optional for compatibility: without it, chunks are appended.
       */
      offset?: number;
    }
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
  | { type: 'toast'; level: 'info' | 'warning' | 'error'; title: string; body: string; url?: string }
  /** The owner's read mark moved (another device read the conversation). */
  | { type: 'channel.read'; channelId: string; lastReadAt: ISODate }
  | { type: 'followups.updated' }
  /** A draft changed: the id only (a whole thread can exceed what a NOTIFY carries); the UI refetches it. */
  | { type: 'draft.updated'; draftId: string }
  | { type: 'watches.updated' }
  /** Emergency stop engaged (state) or lifted (null). */
  | { type: 'emergency.updated'; state: EmergencyStopState | null }
  /** Something on the Santé screen changed (worker down/back, backup, failed job). */
  | { type: 'health.updated' };

/** Messages the browser sends on /api/ws. */
export type ClientEvent =
  | { type: 'ping' }
  /**
   * Presence: which conversation is on screen (null = none) and whether the page is visible. Sent on every
   * change and every 30 s while visible; the server forgets a connection after 60 s without news.
   */
  | { type: 'focus'; channelId: string | null; visible: boolean };

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
