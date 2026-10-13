import { useMemo } from 'react';
import { QueryClient, useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import type {
  ApprovalDTO,
  AuditEntryDTO,
  AuthSessionDTO,
  AuthStateDTO,
  BotDTO,
  ChannelDTO,
  ComputerStatusDTO,
  FileEntryDTO,
  MemoryItemDTO,
  MessageDTO,
  NudgeDTO,
  PasskeyDTO,
  PushPublicKeyDTO,
  QuotaStatusDTO,
  RoutineDTO,
  RunDTO,
  SearchResultDTO,
  SettingsDTO,
  TaskDTO,
  UsageRowDTO,
} from '@ant/shared';
import { ApiError, get } from './api';
import type { ThreadData } from './cache';

export const MESSAGES_PAGE_SIZE = 50;
export const AUDIT_PAGE_SIZE = 100;

export const qk = {
  authState: ['auth', 'state'] as const,
  passkeys: ['auth', 'passkeys'] as const,
  sessions: ['auth', 'sessions'] as const,
  bots: ['bots'] as const,
  channels: ['channels'] as const,
  messages: (channelId: string) => ['messages', channelId] as const,
  messagesAll: ['messages'] as const,
  thread: (rootId: string) => ['thread', rootId] as const,
  threadAll: ['thread'] as const,
  activeRuns: ['runs', 'active'] as const,
  runs: (botId?: string, limit?: number) => ['runs', 'list', botId ?? null, limit ?? null] as const,
  runsList: ['runs', 'list'] as const,
  approvals: (status: 'pending' | 'all') => ['approvals', status] as const,
  /** One approval, for those older than the list's window. Under ['approvals'], so approval.updated refreshes it. */
  approval: (id: string) => ['approvals', 'one', id] as const,
  approvalsAll: ['approvals'] as const,
  quota: ['quota'] as const,
  usage: (days: number) => ['quota', 'usage', days] as const,
  settings: ['settings'] as const,
  memory: (p: MemoryParams) => ['memory', p] as const,
  memoryAll: ['memory'] as const,
  tasks: (botId?: string, status?: string) => ['tasks', botId ?? null, status ?? null] as const,
  tasksAll: ['tasks'] as const,
  nudges: (botId?: string, limit?: number) => ['nudges', botId ?? null, limit ?? null] as const,
  nudgesAll: ['nudges'] as const,
  routines: ['routines'] as const,
  search: (p: SearchParams) => ['search', p] as const,
  computerStatus: ['computer', 'status'] as const,
  computerFiles: (path: string) => ['computer', 'files', path] as const,
  computerActivity: ['computer', 'activity'] as const,
  audit: (p: AuditParams) => ['audit', p] as const,
  pushKey: ['push', 'key'] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => {
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

// ───────────── Auth ─────────────
/**
 * The session state. A 200 answer that is not one (captive portal, proxy maintenance page, empty body) is treated
 * as an unreachable server, never as a logged-out owner.
 */
export async function fetchAuthState(): Promise<AuthStateDTO> {
  const s = await get<AuthStateDTO | null>('/api/auth/state');
  if (typeof s !== 'object' || s === null || typeof s.authenticated !== 'boolean') {
    throw new ApiError(0, 'network', 'Serveur injoignable. Vérifie ta connexion.');
  }
  return s;
}

export const useAuthState = () => useQuery({ queryKey: qk.authState, queryFn: fetchAuthState, staleTime: 0 });
export const usePasskeys = () => useQuery({ queryKey: qk.passkeys, queryFn: () => get<PasskeyDTO[]>('/api/auth/passkeys') });
export const useSessions = () =>
  useQuery({ queryKey: qk.sessions, queryFn: () => get<AuthSessionDTO[]>('/api/auth/sessions') });

// ───────────── Bots & channels ─────────────
export const useBots = () => useQuery({ queryKey: qk.bots, queryFn: () => get<BotDTO[]>('/api/bots') });
export const useChannels = () => useQuery({ queryKey: qk.channels, queryFn: () => get<ChannelDTO[]>('/api/channels') });

export function useBotMap(): Map<string, BotDTO> {
  const { data } = useBots();
  return useMemo(() => new Map((data ?? []).map((b) => [b.id, b])), [data]);
}

/**
 * Cursor of the page before `lastPage` (oldest first): the id of its oldest message, an exact keyset cursor on the
 * server. A date would skip messages written within the same millisecond as that message.
 */
export function nextMessagesCursor(lastPage: Pick<MessageDTO, 'id'>[]): string | undefined {
  return lastPage.length < MESSAGES_PAGE_SIZE ? undefined : lastPage[0]?.id;
}

export function useChannelMessages(channelId: string) {
  return useInfiniteQuery<MessageDTO[], Error, InfiniteData<MessageDTO[], string | null>, readonly unknown[], string | null>({
    queryKey: qk.messages(channelId),
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      get<MessageDTO[]>(
        `/api/channels/${channelId}/messages`,
        { before: pageParam ?? undefined, limit: MESSAGES_PAGE_SIZE },
        signal,
      ),
    getNextPageParam: nextMessagesCursor,
    staleTime: 60_000,
  });
}

export const useThread = (rootId: string | undefined) =>
  useQuery({
    queryKey: qk.thread(rootId ?? ''),
    queryFn: () => get<ThreadData>(`/api/messages/${rootId}/thread`),
    enabled: !!rootId,
  });

// ───────────── Runs ─────────────
export const useActiveRuns = () =>
  useQuery({ queryKey: qk.activeRuns, queryFn: () => get<RunDTO[]>('/api/runs/active'), staleTime: 15_000 });
export const useRuns = (botId?: string, limit = 20) =>
  useQuery({ queryKey: qk.runs(botId, limit), queryFn: () => get<RunDTO[]>('/api/runs', { botId, limit }) });

// ───────────── Approvals ─────────────
export const usePendingApprovals = () =>
  useQuery({ queryKey: qk.approvals('pending'), queryFn: () => get<ApprovalDTO[]>('/api/approvals', { status: 'pending' }) });
export const useAllApprovals = (enabled = true) =>
  useQuery({ queryKey: qk.approvals('all'), queryFn: () => get<ApprovalDTO[]>('/api/approvals'), enabled });
/** GET /api/approvals only returns the most recent ones: older approvals referenced in a conversation are fetched alone. */
export const useApproval = (id: string, enabled = true) =>
  useQuery({ queryKey: qk.approval(id), queryFn: () => get<ApprovalDTO>(`/api/approvals/${encodeURIComponent(id)}`), enabled, retry: false });

// ───────────── Quota & settings ─────────────
export const useQuota = () => useQuery({ queryKey: qk.quota, queryFn: () => get<QuotaStatusDTO>('/api/quota') });

/** True when the server reports that the worker stopped answering (false when it does not report it). */
export function isWorkerDown(quota: Pick<QuotaStatusDTO, 'worker'> | undefined): boolean {
  return quota?.worker ? !quota.worker.alive : false;
}

/**
 * Whether the worker, which runs the bots, looks stopped. A stopped worker publishes no event, so the quota is
 * polled while the server reports the worker's heartbeat.
 */
export function useWorkerDown(): boolean {
  const { data } = useQuery({
    queryKey: qk.quota,
    queryFn: () => get<QuotaStatusDTO>('/api/quota'),
    refetchInterval: (q) => (q.state.data?.worker ? 60_000 : false),
  });
  return isWorkerDown(data);
}
export const useUsage = (days = 30) =>
  useQuery({ queryKey: qk.usage(days), queryFn: () => get<UsageRowDTO[]>('/api/quota/usage', { days }) });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => get<SettingsDTO>('/api/settings') });

// ───────────── Memory, tasks, nudges, routines ─────────────
export interface MemoryParams {
  scope: 'shared' | 'bot';
  botId?: string;
  q?: string;
  kind?: string;
}
export const useMemory = (p: MemoryParams) =>
  useQuery({
    queryKey: qk.memory(p),
    queryFn: () => get<MemoryItemDTO[]>('/api/memory', { scope: p.scope, botId: p.botId, q: p.q, kind: p.kind }),
    enabled: p.scope === 'shared' || !!p.botId,
  });

export const useTasks = (botId?: string, status = 'open,waiting') =>
  useQuery({ queryKey: qk.tasks(botId, status), queryFn: () => get<TaskDTO[]>('/api/tasks', { botId, status }) });
export const useNudges = (botId?: string, limit = 20) =>
  useQuery({ queryKey: qk.nudges(botId, limit), queryFn: () => get<NudgeDTO[]>('/api/nudges', { botId, limit }) });
export const useRoutines = () => useQuery({ queryKey: qk.routines, queryFn: () => get<RoutineDTO[]>('/api/routines') });

// ───────────── Search ─────────────
export interface SearchParams {
  q: string;
  channelId?: string;
  botId?: string;
  from?: string;
  to?: string;
}
export const useSearch = (p: SearchParams) =>
  useQuery({
    queryKey: qk.search(p),
    queryFn: ({ signal }) =>
      get<SearchResultDTO[]>('/api/search', { q: p.q, channelId: p.channelId, botId: p.botId, from: p.from, to: p.to }, signal),
    enabled: p.q.trim().length > 0,
    staleTime: 10_000,
  });

// ───────────── Computer ─────────────
export const useComputerStatus = () =>
  useQuery({
    queryKey: qk.computerStatus,
    queryFn: () => get<ComputerStatusDTO>('/api/computer/status'),
    refetchInterval: 30_000,
  });
export const useComputerFiles = (path: string, enabled: boolean) =>
  useQuery({
    queryKey: qk.computerFiles(path),
    queryFn: () => get<FileEntryDTO[]>('/api/computer/files', { path }),
    enabled,
  });
export const useComputerActivity = (enabled: boolean) =>
  useQuery({
    queryKey: qk.computerActivity,
    queryFn: () => get<AuditEntryDTO[]>('/api/computer/activity', { limit: 50 }),
    enabled,
  });

// ───────────── Audit ─────────────
export interface AuditParams {
  event?: string;
  actor?: string;
}
export function useAudit(p: AuditParams) {
  return useInfiniteQuery<AuditEntryDTO[], Error, InfiniteData<AuditEntryDTO[], number | null>, readonly unknown[], number | null>({
    queryKey: qk.audit(p),
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      get<AuditEntryDTO[]>('/api/audit', { event: p.event, actor: p.actor, before: pageParam ?? undefined, limit: AUDIT_PAGE_SIZE }, signal),
    getNextPageParam: (lastPage) =>
      lastPage.length < AUDIT_PAGE_SIZE ? undefined : (lastPage[lastPage.length - 1]?.id ?? undefined),
  });
}

export const usePushKey = () =>
  useQuery({ queryKey: qk.pushKey, queryFn: () => get<PushPublicKeyDTO>('/api/push/public-key'), staleTime: Infinity });
