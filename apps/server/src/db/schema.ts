import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ApprovalCategory,
  ApprovalStatus,
  AuthorKind,
  BotPermissions,
  ChannelKind,
  CompletionPushMode,
  ComputeSource,
  ComputerHolder,
  DraftKind,
  DraftPlatform,
  DraftStatus,
  EffortLevel,
  FollowupCreator,
  FollowupKind,
  FollowupStatus,
  MemoryKind,
  MemoryScope,
  MessageMeta,
  MessageStatus,
  NudgeKind,
  NudgeStatus,
  RunOrigin,
  RunPriority,
  RunDepth,
  RunStatus,
  RunTrigger,
  TaskAssignee,
  TaskStatus,
  TimeRange,
  UsagePurpose,
  WatchKind,
  WatchRender,
} from '@ant/shared';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

// ─────────────────────────────── Auth ───────────────────────────────

export interface RecoveryCode {
  hash: string;
  usedAt: string | null;
}

export const owner = pgTable('owner', {
  id: integer('id').primaryKey().default(1),
  passwordHash: text('password_hash').notNull(),
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  recoveryCodes: jsonb('recovery_codes').$type<RecoveryCode[]>().notNull().default([]),
  webauthnUserId: text('webauthn_user_id').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: jsonb('transports').$type<string[]>().notNull().default([]),
  deviceType: text('device_type'),
  backedUp: boolean('backed_up').notNull().default(false),
  name: text('name').notNull(),
  createdAt: createdAt(),
  lastUsedAt: ts('last_used_at'),
});

export const authChallenges = pgTable('auth_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  challenge: text('challenge').notNull(),
  purpose: text('purpose').$type<'register' | 'login'>().notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export type SessionStage = 'full' | 'mfa' | 'enroll';

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(), // sha256(token)
    stage: text('stage').$type<SessionStage>().notNull(),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('auth_sessions_expires_idx').on(t.expiresAt)],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ip: text('ip').notNull(),
    kind: text('kind').notNull(),
    success: boolean('success').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('login_attempts_ip_at_idx').on(t.ip, t.at)],
);

// ─────────────────────────── Bots & channels ───────────────────────────

export const bots = pgTable('bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  avatar: text('avatar').notNull().default('🐜'),
  role: text('role').notNull(),
  instructions: text('instructions').notNull().default(''),
  model: text('model').notNull(),
  effort: text('effort').$type<EffortLevel>().notNull(),
  permissions: jsonb('permissions').$type<BotPermissions>().notNull(),
  heartbeatEnabled: boolean('heartbeat_enabled').notNull().default(true),
  heartbeatIntervalMin: integer('heartbeat_interval_min').notNull().default(180),
  quietHours: jsonb('quiet_hours').$type<TimeRange | null>(),
  apiDailyCapUsd: doublePrecision('api_daily_cap_usd'),
  paused: boolean('paused').notNull().default(false),
  /** Completion push of this bot's runs; null = global setting. */
  completionPush: text('completion_push').$type<CompletionPushMode>(),
  lastHeartbeatAt: ts('last_heartbeat_at'),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<ChannelKind>().notNull(),
  name: text('name').notNull(),
  topic: text('topic').notNull().default(''),
  dmBotId: uuid('dm_bot_id').references(() => bots.id),
  lastMessageAt: ts('last_message_at'),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
});

export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.botId] })],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    threadRootId: uuid('thread_root_id'),
    authorKind: text('author_kind').$type<AuthorKind>().notNull(),
    botId: uuid('bot_id').references(() => bots.id),
    content: text('content').notNull(),
    meta: jsonb('meta').$type<MessageMeta>().notNull().default({}),
    status: text('status').$type<MessageStatus>().notNull().default('done'),
    runId: uuid('run_id'),
    searchVector: tsvector('search_vector').generatedAlwaysAs(sql`to_tsvector('french', ant_unaccent(coalesce(content, '')))`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('messages_channel_created_idx').on(t.channelId, t.createdAt),
    index('messages_thread_idx').on(t.threadRootId, t.createdAt),
    index('messages_search_idx').using('gin', t.searchVector),
  ],
);

// ─────────────────────────── Agent execution ───────────────────────────

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    threadKey: text('thread_key').notNull(),
    sdkSessionId: text('sdk_session_id'),
    generation: integer('generation').notNull().default(1),
    approxTokens: integer('approx_tokens').notNull().default(0),
    summary: text('summary'),
    /** Last channel message this bot has seen in this conversation (to feed it what others wrote since). */
    lastSeenAt: ts('last_seen_at'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('agent_sessions_active_uidx').on(t.botId, t.threadKey).where(sql`${t.active}`)],
);

export interface RunPayload {
  approvalId?: string;
  routineId?: string;
  nudgeTopics?: string[];
  handoffFromBotId?: string;
  resumeAfterSwitch?: boolean;
  /** Handoff with return: when every run sharing `reportTo.runId` is over, that bot is woken with their answers. */
  reportTo?: { runId: string; botId: string };
  /** Run started by a followup of kind `work`. */
  followupId?: string;
  /** Run started by a watch that changed. */
  watchId?: string;
  /** Run started by the owner's edit or rejection of a draft. */
  draftId?: string;
  /** One-off model chosen by the owner for this message (« Approfondir »). */
  depth?: RunDepth;
  /** Automatic continuation (step limit): trigger of the run it continues (see effectiveTrigger()). */
  continuedTrigger?: string;
  /** Automatic continuation: first start of the first run of the chain, ISO (see chainStartedAt()). */
  chainStartedAt?: string;
  /** When the feature modules' afterRun hooks ran for this run's final state, ISO (they run at most once normally). */
  afterRunAt?: string;
  [key: string]: unknown;
}

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id),
    channelId: uuid('channel_id').references(() => channels.id),
    threadRootId: uuid('thread_root_id'),
    threadKey: text('thread_key').notNull(),
    trigger: text('trigger').$type<RunTrigger>().notNull(),
    priority: text('priority').$type<RunPriority>().notNull(),
    origin: text('origin').$type<RunOrigin>().notNull(),
    chainId: uuid('chain_id').notNull(),
    hop: integer('hop').notNull().default(0),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    computeSource: text('compute_source').$type<ComputeSource>(),
    computeReason: text('compute_reason'),
    model: text('model').notNull(),
    effort: text('effort').$type<EffortLevel>().notNull(),
    prompt: text('prompt').notNull(),
    payload: jsonb('payload').$type<RunPayload>().notNull().default({}),
    activity: text('activity'),
    responseMessageId: uuid('response_message_id'),
    sdkSessionId: text('sdk_session_id'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('runs_bot_created_idx').on(t.botId, t.createdAt),
    index('runs_status_idx').on(t.status),
    index('runs_chain_idx').on(t.chainId),
  ],
);

export const runModelUsage = pgTable(
  'run_model_usage',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id').references(() => runs.id),
    botId: uuid('bot_id').references(() => bots.id),
    day: text('day').notNull(),
    month: text('month').notNull(),
    model: text('model').notNull(),
    computeSource: text('compute_source').$type<ComputeSource>().notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    /** What the call was for (run trigger, or one-shot purpose); null on rows written before it existed. */
    purpose: text('purpose').$type<UsagePurpose>(),
    /** Routine whose run made the call. No foreign key: a routine deleted while its run is in flight must not make the insert fail. */
    routineId: uuid('routine_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('run_model_usage_day_idx').on(t.day),
    index('run_model_usage_month_idx').on(t.month, t.computeSource),
    index('run_model_usage_routine_idx').on(t.routineId),
  ],
);

export const handoffs = pgTable(
  'handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: uuid('chain_id').notNull(),
    fromBotId: uuid('from_bot_id')
      .notNull()
      .references(() => bots.id),
    toBotId: uuid('to_bot_id')
      .notNull()
      .references(() => bots.id),
    runId: uuid('run_id'),
    createdAt: createdAt(),
  },
  (t) => [index('handoffs_chain_idx').on(t.chainId, t.createdAt)],
);

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    runAt: ts('run_at').notNull().defaultNow(),
    status: text('status').$type<JobStatus>().notNull().default('pending'),
    /** Jobs sharing a lane never run concurrently (e.g. one run per bot and thread). */
    lane: text('lane'),
    /** Prevents duplicate scheduling of the same logical job. */
    dedupeKey: text('dedupe_key'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lockedAt: ts('locked_at'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('jobs_pending_idx').on(t.status, t.runAt),
    uniqueIndex('jobs_dedupe_uidx').on(t.dedupeKey),
    index('jobs_lane_idx').on(t.lane, t.status),
  ],
);

// ──────────────────────────── Quota & budget ────────────────────────────

export const computeState = pgTable('compute_state', {
  id: integer('id').primaryKey().default(1),
  /** Written by the worker at start-up: which credentials exist in its environment (never the values). */
  subConfigured: boolean('sub_configured').notNull().default(false),
  apiConfigured: boolean('api_configured').notNull().default(false),
  subLimitedUntil: ts('sub_limited_until'),
  subFiveHourUtil: doublePrecision('sub_five_hour_util'),
  subFiveHourResetsAt: ts('sub_five_hour_resets_at'),
  subSevenDayUtil: doublePrecision('sub_seven_day_util'),
  subSevenDayResetsAt: ts('sub_seven_day_resets_at'),
  subLastStatus: text('sub_last_status'),
  subAuthFailed: boolean('sub_auth_failed').notNull().default(false),
  subLastEventAt: ts('sub_last_event_at'),
  apiAuthFailed: boolean('api_auth_failed').notNull().default(false),
  allPausedReason: text('all_paused_reason'),
  updatedAt: updatedAt(),
});

/**
 * Liveness of the services that cannot be asked directly: the worker (every scheduler pass), the backup service
 * (after each attempt, through psql) and the last connection test (`diagnostic`). Keys: ServiceKey (@ant/shared).
 */
export const serviceStatus = pgTable('service_status', {
  key: text('key').primaryKey(),
  seenAt: ts('seen_at').notNull().defaultNow(),
  version: text('version'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});

export const subscriptionEvents = pgTable('subscription_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: ts('at').notNull().defaultNow(),
  status: text('status').notNull(),
  limitType: text('limit_type'),
  utilization: doublePrecision('utilization'),
  resetsAt: ts('resets_at'),
  raw: jsonb('raw').notNull(),
});

export const budgetAlerts = pgTable(
  'budget_alerts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    scope: text('scope').notNull(),
    periodKey: text('period_key').notNull(),
    threshold: integer('threshold').notNull(),
    sentAt: ts('sent_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('budget_alerts_uidx').on(t.scope, t.periodKey, t.threshold)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

// ─────────────────────── Memory, tasks, proactivity ───────────────────────

export const memoryItems = pgTable(
  'memory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').$type<MemoryScope>().notNull(),
    botId: uuid('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<MemoryKind>().notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    pinned: boolean('pinned').notNull().default(false),
    importance: integer('importance').notNull().default(3),
    authorKind: text('author_kind').$type<'user' | 'bot'>().notNull(),
    authorBotId: uuid('author_bot_id').references(() => bots.id),
    sourceMessageId: uuid('source_message_id'),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('french', ant_unaccent(coalesce(title, '') || ' ' || coalesce(content, '')))`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('memory_scope_idx').on(t.scope, t.botId), index('memory_search_idx').using('gin', t.searchVector)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    details: text('details').notNull().default(''),
    status: text('status').$type<TaskStatus>().notNull().default('open'),
    /** `owner`: something the owner has to do, tracked by `botId`. */
    assignee: text('assignee').$type<TaskAssignee>().notNull().default('bot'),
    dueAt: ts('due_at'),
    sourceMessageId: uuid('source_message_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tasks_bot_status_idx').on(t.botId, t.status), index('tasks_assignee_status_idx').on(t.assignee, t.status)],
);

export const nudges = pgTable(
  'nudges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NudgeKind>().notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').$type<NudgeStatus>().notNull().default('delivered'),
    messageId: uuid('message_id'),
    createdAt: createdAt(),
    deliveredAt: ts('delivered_at'),
  },
  (t) => [index('nudges_bot_created_idx').on(t.botId, t.createdAt), index('nudges_fingerprint_idx').on(t.fingerprint)],
);

export const routines = pgTable('routines', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id')
    .notNull()
    .references(() => bots.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'cascade' }),
  sourceText: text('source_text').notNull(),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull(),
  instruction: text('instruction').notNull(),
  urgent: boolean('urgent').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  /** Proposed by a bot (routine_propose), not yet enabled by the owner. */
  proposed: boolean('proposed').notNull().default(false),
  /** Completion push of this routine's runs; null = its bot's setting. */
  completionPush: text('completion_push').$type<CompletionPushMode>(),
  /** « Silencieux si rien » : nothing is posted when the bot answers RIEN. */
  silentIfNothing: boolean('silent_if_nothing').notNull().default(false),
  lastRunAt: ts('last_run_at'),
  nextRunAt: ts('next_run_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Reminders and deferred work. `reminder`: the text is posted and pushed without any model call. `work`: the
 * scheduler starts a run (trigger `followup`). One row per task due date (`task_id`), moved with it.
 */
export const followups = pgTable(
  'followups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<FollowupKind>().notNull(),
    /** null: the owner's own reminder (system message and push). */
    botId: uuid('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    /** null: push only. */
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    threadRootId: uuid('thread_root_id'),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runAt: ts('run_at').notNull(),
    instruction: text('instruction').notNull(),
    createdBy: text('created_by').$type<FollowupCreator>().notNull(),
    /** Run whose bot scheduled it (followup_schedule). */
    createdByRunId: uuid('created_by_run_id'),
    chainId: uuid('chain_id'),
    /** Followups chained without a message from the owner (FOLLOWUP_LIMITS.maxChainDepth). */
    depth: integer('depth').notNull().default(0),
    status: text('status').$type<FollowupStatus>().notNull().default('pending'),
    sourceMessageId: uuid('source_message_id'),
    firedAt: ts('fired_at'),
    /** Run started when a `work` followup fired. */
    runId: uuid('run_id'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('followups_due_idx').on(t.status, t.runAt),
    index('followups_bot_status_idx').on(t.botId, t.status),
    index('followups_task_idx').on(t.taskId),
  ],
);

/** The owner's read mark per conversation, shared by all his devices. */
export const channelReads = pgTable('channel_reads', {
  channelId: uuid('channel_id')
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  lastReadAt: ts('last_read_at').notNull(),
  updatedAt: updatedAt(),
});

/**
 * One row per open realtime connection (web service): which conversation is on screen and whether the page is
 * visible. Rows older than PRESENCE_TTL_MS count as gone; closed connections delete theirs.
 */
export const ownerPresence = pgTable(
  'owner_presence',
  {
    connectionId: text('connection_id').primaryKey(),
    /** sha256 of the session token (auth_sessions.id). */
    sessionId: text('session_id'),
    channelId: uuid('channel_id'),
    visible: boolean('visible').notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [index('owner_presence_channel_idx').on(t.channelId, t.updatedAt)],
);

/** Posts prepared by a bot, edited and approved by the owner, published by hand (X web intent). */
export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    threadRootId: uuid('thread_root_id'),
    /** Card message in the conversation. */
    messageId: uuid('message_id'),
    createdByRunId: uuid('created_by_run_id'),
    platform: text('platform').$type<DraftPlatform>().notNull().default('x'),
    kind: text('kind').$type<DraftKind>().notNull().default('post'),
    parts: jsonb('parts').$type<string[]>().notNull(),
    replyToUrl: text('reply_to_url'),
    mediaPaths: jsonb('media_paths').$type<string[]>().notNull().default([]),
    notes: text('notes').notNull().default(''),
    status: text('status').$type<DraftStatus>().notNull().default('draft'),
    scheduledAt: ts('scheduled_at'),
    /** « À publier maintenant » push sent for the current scheduledAt. */
    notifiedAt: ts('notified_at'),
    publishedUrl: text('published_url'),
    publishedAt: ts('published_at'),
    ownerFeedback: text('owner_feedback'),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('drafts_status_idx').on(t.status, t.scheduledAt), index('drafts_bot_created_idx').on(t.botId, t.createdAt)],
);

/** Pages and feeds checked without any model call (fetched inside the computer); the bot is woken only on change. */
export const watches = pgTable(
  'watches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    kind: text('kind').$type<WatchKind>().notNull().default('page'),
    selector: text('selector'),
    render: text('render').$type<WatchRender>().notNull().default('http'),
    intervalMin: integer('interval_min').notNull().default(60),
    instruction: text('instruction').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Proposed by a bot (watch_propose), not yet enabled by the owner. */
    proposed: boolean('proposed').notNull().default(false),
    lastHash: text('last_hash'),
    /** Normalised text of the last check (WATCH_LIMITS.maxSnapshotBytes). */
    lastSnapshot: text('last_snapshot'),
    lastDiff: text('last_diff'),
    lastError: text('last_error'),
    lastCheckedAt: ts('last_checked_at'),
    lastChangedAt: ts('last_changed_at'),
    nextCheckAt: ts('next_check_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('watches_due_idx').on(t.enabled, t.nextCheckAt), index('watches_bot_idx').on(t.botId)],
);

// ─────────────────────── Computer, approvals, audit ───────────────────────

export const computerState = pgTable('computer_state', {
  id: integer('id').primaryKey().default(1),
  holder: text('holder').$type<ComputerHolder>().notNull().default('agents'),
  since: ts('since').notNull().defaultNow(),
  activeBotId: uuid('active_bot_id'),
  lastAction: text('last_action'),
  url: text('url'),
  updatedAt: updatedAt(),
});

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id'),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id),
    channelId: uuid('channel_id'),
    threadRootId: uuid('thread_root_id'),
    category: text('category').$type<ApprovalCategory>().notNull(),
    tool: text('tool').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    screenshotPng: text('screenshot_png'),
    urgent: boolean('urgent').notNull().default(false),
    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    comment: text('comment'),
    result: text('result'),
    createdAt: createdAt(),
    decidedAt: ts('decided_at'),
    executedAt: ts('executed_at'),
    expiresAt: ts('expires_at').notNull(),
    /** A domain grant withdrawn by the owner before its 30 minutes ran out. */
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('approvals_status_idx').on(t.status, t.createdAt)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    actor: text('actor').notNull(),
    event: text('event').notNull(),
    runId: uuid('run_id'),
    tool: text('tool'),
    detail: jsonb('detail'),
    outcome: text('outcome'),
    ip: text('ip'),
  },
  (t) => [index('audit_at_idx').on(t.at), index('audit_event_idx').on(t.event, t.at)],
);

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  failures: integer('failures').notNull().default(0),
  createdAt: createdAt(),
  lastOkAt: ts('last_ok_at'),
});
