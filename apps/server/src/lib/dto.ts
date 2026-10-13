import type {
  ApprovalDTO,
  BotDTO,
  ChannelDTO,
  DraftDTO,
  FollowupDTO,
  JobDTO,
  MemoryItemDTO,
  MessageDTO,
  NudgeDTO,
  RunDTO,
  TaskDTO,
  WatchDTO,
} from '@ant/shared';
import { DEFAULT_BOT_PERMISSIONS } from '@ant/shared';
import type { approvals, bots, channels, drafts, followups, jobs, memoryItems, messages, nudges, runs, tasks, watches } from '../db/schema';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function botToDTO(row: Row<typeof bots>, dmChannelId: string, activity: string | null = null): BotDTO {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    avatar: row.avatar,
    role: row.role,
    instructions: row.instructions,
    model: row.model,
    effort: row.effort,
    permissions: { ...DEFAULT_BOT_PERMISSIONS, ...row.permissions },
    heartbeatEnabled: row.heartbeatEnabled,
    heartbeatIntervalMin: row.heartbeatIntervalMin,
    quietHours: row.quietHours ?? null,
    apiDailyCapUsd: row.apiDailyCapUsd ?? null,
    paused: row.paused,
    completionPush: row.completionPush ?? null,
    dmChannelId,
    activity,
    createdAt: row.createdAt.toISOString(),
  };
}

export function channelToDTO(
  row: Row<typeof channels>,
  botIds: string[],
  lastMessage: ChannelDTO['lastMessage'] = null,
  lastReadAt: Date | null = null,
): ChannelDTO {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    topic: row.topic,
    botIds,
    dmBotId: row.dmBotId ?? null,
    lastMessageAt: iso(row.lastMessageAt),
    lastMessage,
    lastReadAt: iso(lastReadAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export function messageToDTO(row: Row<typeof messages>, replyCount = 0, lastReplyAt: Date | null = null): MessageDTO {
  return {
    id: row.id,
    channelId: row.channelId,
    threadRootId: row.threadRootId ?? null,
    authorKind: row.authorKind,
    botId: row.botId ?? null,
    content: row.content,
    meta: row.meta ?? {},
    status: row.status,
    replyCount,
    lastReplyAt: iso(lastReplyAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function runToDTO(row: Row<typeof runs>): RunDTO {
  return {
    id: row.id,
    botId: row.botId,
    channelId: row.channelId ?? null,
    threadRootId: row.threadRootId ?? null,
    trigger: row.trigger,
    priority: row.priority,
    status: row.status,
    computeSource: row.computeSource ?? null,
    computeReason: row.computeReason ?? null,
    model: row.model,
    effort: row.effort,
    activity: row.activity ?? null,
    costUsd: row.costUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

export function memoryToDTO(row: Row<typeof memoryItems>): MemoryItemDTO {
  return {
    id: row.id,
    scope: row.scope,
    botId: row.botId ?? null,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: row.tags,
    pinned: row.pinned,
    importance: row.importance,
    authorKind: row.authorKind,
    authorBotId: row.authorBotId ?? null,
    sourceMessageId: row.sourceMessageId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function taskToDTO(row: Row<typeof tasks>): TaskDTO {
  return {
    id: row.id,
    botId: row.botId,
    assignee: row.assignee,
    title: row.title,
    details: row.details,
    status: row.status,
    dueAt: iso(row.dueAt),
    sourceMessageId: row.sourceMessageId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function nudgeToDTO(row: Row<typeof nudges>): NudgeDTO {
  return {
    id: row.id,
    botId: row.botId,
    kind: row.kind,
    title: row.title,
    content: row.content,
    status: row.status,
    messageId: row.messageId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A full approval row, or a list row that carries `hasScreenshot` instead of the (heavy) base64 capture. */
export type ApprovalRowLike = Omit<Row<typeof approvals>, 'screenshotPng'> & ({ screenshotPng: string | null } | { hasScreenshot: boolean });

export function approvalToDTO(row: ApprovalRowLike): ApprovalDTO {
  return {
    id: row.id,
    runId: row.runId ?? null,
    botId: row.botId,
    channelId: row.channelId ?? null,
    category: row.category,
    tool: row.tool,
    title: row.title,
    summary: row.summary,
    payload: row.payload,
    hasScreenshot: 'hasScreenshot' in row ? row.hasScreenshot : Boolean(row.screenshotPng),
    urgent: row.urgent,
    status: row.status,
    comment: row.comment ?? null,
    result: row.result ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: iso(row.revokedAt),
  };
}

export function followupToDTO(row: Row<typeof followups>): FollowupDTO {
  return {
    id: row.id,
    kind: row.kind,
    botId: row.botId ?? null,
    channelId: row.channelId ?? null,
    threadRootId: row.threadRootId ?? null,
    taskId: row.taskId ?? null,
    runAt: row.runAt.toISOString(),
    instruction: row.instruction,
    createdBy: row.createdBy,
    status: row.status,
    firedAt: iso(row.firedAt),
    runId: row.runId ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function draftToDTO(row: Row<typeof drafts>): DraftDTO {
  return {
    id: row.id,
    botId: row.botId,
    channelId: row.channelId ?? null,
    threadRootId: row.threadRootId ?? null,
    messageId: row.messageId ?? null,
    platform: row.platform,
    kind: row.kind,
    parts: row.parts,
    replyToUrl: row.replyToUrl ?? null,
    mediaPaths: row.mediaPaths,
    notes: row.notes,
    status: row.status,
    scheduledAt: iso(row.scheduledAt),
    publishedUrl: row.publishedUrl ?? null,
    publishedAt: iso(row.publishedAt),
    ownerFeedback: row.ownerFeedback ?? null,
    decidedAt: iso(row.decidedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function watchToDTO(row: Row<typeof watches>): WatchDTO {
  return {
    id: row.id,
    botId: row.botId,
    channelId: row.channelId,
    url: row.url,
    kind: row.kind,
    selector: row.selector ?? null,
    render: row.render,
    intervalMin: row.intervalMin,
    instruction: row.instruction,
    enabled: row.enabled,
    proposed: row.proposed,
    lastCheckedAt: iso(row.lastCheckedAt),
    lastChangedAt: iso(row.lastChangedAt),
    lastDiff: row.lastDiff ?? null,
    lastError: row.lastError ?? null,
    nextCheckAt: iso(row.nextCheckAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function jobToDTO(row: Row<typeof jobs>): JobDTO {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError ?? null,
    payload: row.payload,
    runAt: row.runAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}
