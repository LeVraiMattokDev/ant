import type { ApprovalDTO, BotDTO, MessageDTO, RunDTO } from '@ant/shared';
import { DEFAULT_BOT_PERMISSIONS } from '@ant/shared';

export function msg(p: Partial<MessageDTO> & { id: string }): MessageDTO {
  return {
    channelId: 'c1',
    threadRootId: null,
    authorKind: 'bot',
    botId: 'b1',
    content: '',
    meta: {},
    status: 'done',
    replyCount: 0,
    lastReplyAt: null,
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:00:00.000Z',
    ...p,
  };
}

export function run(p: Partial<RunDTO> & { id: string }): RunDTO {
  return {
    botId: 'b1',
    channelId: 'c1',
    threadRootId: null,
    trigger: 'user',
    priority: 'interactive',
    status: 'running',
    computeSource: 'subscription',
    computeReason: null,
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    activity: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    error: null,
    createdAt: '2026-10-12T10:00:00.000Z',
    startedAt: '2026-10-12T10:00:01.000Z',
    finishedAt: null,
    ...p,
  };
}

export function approval(p: Partial<ApprovalDTO> & { id: string }): ApprovalDTO {
  return {
    runId: 'r1',
    botId: 'b1',
    channelId: 'c1',
    category: 'message_externe',
    tool: 'send_email',
    title: 'Envoyer un e-mail à Marie',
    summary: 'Réponse à **Marie** au sujet du devis.',
    payload: { to: 'marie@example.com' },
    hasScreenshot: false,
    urgent: false,
    status: 'pending',
    comment: null,
    result: null,
    createdAt: '2026-10-12T10:00:00.000Z',
    decidedAt: null,
    expiresAt: '2099-10-15T10:00:00.000Z',
    ...p,
  };
}

export function bot(p: Partial<BotDTO> & { id: string }): BotDTO {
  return {
    slug: 'dev',
    name: 'Dev',
    avatar: '🛠️',
    role: 'Développeur',
    instructions: '',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    permissions: { ...DEFAULT_BOT_PERMISSIONS },
    heartbeatEnabled: true,
    heartbeatIntervalMin: 180,
    quietHours: null,
    apiDailyCapUsd: null,
    paused: false,
    dmChannelId: 'dm1',
    activity: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...p,
  };
}
