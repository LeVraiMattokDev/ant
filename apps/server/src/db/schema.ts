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
  ComputeSource,
  ComputerHolder,
  EffortLevel,
  MemoryKind,
  MemoryScope,
  MessageMeta,
  MessageStatus,
  NudgeKind,
  NudgeStatus,
  RunOrigin,
  RunPriority,
  RunStatus,
  RunTrigger,
  TaskStatus,
  TimeRange,
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
    createdAt: createdAt(),
  },
  (t) => [index('run_model_usage_day_idx').on(t.day), index('run_model_usage_month_idx').on(t.month, t.computeSource)],
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
    dueAt: ts('due_at'),
    sourceMessageId: uuid('source_message_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tasks_bot_status_idx').on(t.botId, t.status)],
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
  lastRunAt: ts('last_run_at'),
  nextRunAt: ts('next_run_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
