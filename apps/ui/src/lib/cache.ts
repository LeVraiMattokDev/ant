/**
 * Pure cache reducers used by the WebSocket dispatcher and by mutations.
 * They never mutate their input and return the same reference when nothing changes,
 * so TanStack Query can skip re-renders.
 */
import type { ApprovalDTO, ChannelDTO, MessageDTO, NudgeDTO, RunDTO } from '@ant/shared';

/** Shape of TanStack's InfiniteData for the channel message list. Page 0 is the newest page; each page is oldest → newest. */
export interface MessagePages {
  pages: MessageDTO[][];
  pageParams: (string | null)[];
}

export interface ThreadData {
  root: MessageDTO;
  replies: MessageDTO[];
}

export const ACTIVE_RUN_STATUSES: readonly RunDTO['status'][] = ['queued', 'running', 'waiting_approval'];

export function isRunActive(run: Pick<RunDTO, 'status'>): boolean {
  return ACTIVE_RUN_STATUSES.includes(run.status);
}

/** Flattens the pages into chronological order. */
export function flattenMessages(data: MessagePages | undefined): MessageDTO[] {
  if (!data) return [];
  const out: MessageDTO[] = [];
  for (let i = data.pages.length - 1; i >= 0; i--) out.push(...(data.pages[i] ?? []));
  return out;
}

function mapPages(data: MessagePages, fn: (m: MessageDTO) => MessageDTO): MessagePages {
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const next = page.map((m) => {
      const r = fn(m);
      if (r !== m) pageChanged = true;
      return r;
    });
    if (pageChanged) changed = true;
    return pageChanged ? next : page;
  });
  return changed ? { ...data, pages } : data;
}

function containsMessage(data: MessagePages, id: string): boolean {
  return data.pages.some((p) => p.some((m) => m.id === id));
}

/**
 * Inserts or replaces a top-level message in a channel list. Replies (threadRootId set) are ignored here.
 * New messages are appended to the newest page.
 */
export function upsertChannelMessage(data: MessagePages | undefined, msg: MessageDTO): MessagePages | undefined {
  if (!data || msg.threadRootId) return data;
  if (containsMessage(data, msg.id)) return mapPages(data, (m) => (m.id === msg.id ? msg : m));
  const [first = [], ...rest] = data.pages;
  // Keep chronological order even if events arrive slightly out of order.
  const page = [...first, msg].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { ...data, pages: [page, ...rest] };
}

/** Replaces a message wherever it appears in the channel list (no insertion). */
export function replaceChannelMessage(data: MessagePages | undefined, msg: MessageDTO): MessagePages | undefined {
  if (!data) return data;
  return mapPages(data, (m) => (m.id === msg.id ? msg : m));
}

/** Appends streamed text to a message being generated. */
export function appendDeltaToPages(data: MessagePages | undefined, messageId: string, delta: string): MessagePages | undefined {
  if (!data) return data;
  return mapPages(data, (m) => (m.id === messageId ? { ...m, content: m.content + delta } : m));
}

/** Bumps the reply counter of a thread root when a new reply is created. */
export function bumpReplyCount(data: MessagePages | undefined, reply: MessageDTO): MessagePages | undefined {
  if (!data || !reply.threadRootId) return data;
  return mapPages(data, (m) =>
    m.id === reply.threadRootId
      ? {
          ...m,
          replyCount: m.replyCount + 1,
          lastReplyAt: !m.lastReplyAt || reply.createdAt > m.lastReplyAt ? reply.createdAt : m.lastReplyAt,
        }
      : m,
  );
}

/** Inserts or replaces a reply in an open thread (or replaces the root). */
export function upsertThreadMessage(data: ThreadData | undefined, msg: MessageDTO): ThreadData | undefined {
  if (!data) return data;
  if (msg.id === data.root.id) return { ...data, root: msg };
  if (msg.threadRootId !== data.root.id) return data;
  const idx = data.replies.findIndex((r) => r.id === msg.id);
  if (idx >= 0) {
    const replies = data.replies.slice();
    replies[idx] = msg;
    return { ...data, replies };
  }
  const replies = [...data.replies, msg].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { root: { ...data.root, replyCount: Math.max(data.root.replyCount, replies.length) }, replies };
}

export function appendDeltaToThread(data: ThreadData | undefined, messageId: string, delta: string): ThreadData | undefined {
  if (!data) return data;
  if (data.root.id === messageId) return { ...data, root: { ...data.root, content: data.root.content + delta } };
  const idx = data.replies.findIndex((r) => r.id === messageId);
  if (idx < 0) return data;
  const replies = data.replies.slice();
  const cur = replies[idx]!;
  replies[idx] = { ...cur, content: cur.content + delta };
  return { ...data, replies };
}

/** Keeps the list of active runs in sync: active runs are upserted, finished ones removed. */
export function applyRunUpdate(runs: RunDTO[] | undefined, run: RunDTO): RunDTO[] | undefined {
  if (!runs) return runs;
  const idx = runs.findIndex((r) => r.id === run.id);
  if (isRunActive(run)) {
    if (idx < 0) return [...runs, run];
    const next = runs.slice();
    next[idx] = run;
    return next;
  }
  if (idx < 0) return runs;
  return runs.filter((r) => r.id !== run.id);
}

/** Upserts a run in a list ordered from the most recent. */
export function upsertRunInList(runs: RunDTO[] | undefined, run: RunDTO): RunDTO[] | undefined {
  if (!runs) return runs;
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx < 0) return runs;
  const next = runs.slice();
  next[idx] = run;
  return next;
}

/** Upserts an approval in a list. When `onlyPending` is true, non-pending approvals are removed. */
export function applyApprovalUpdate(
  list: ApprovalDTO[] | undefined,
  approval: ApprovalDTO,
  onlyPending: boolean,
): ApprovalDTO[] | undefined {
  if (!list) return list;
  const idx = list.findIndex((a) => a.id === approval.id);
  if (onlyPending && approval.status !== 'pending') {
    return idx < 0 ? list : list.filter((a) => a.id !== approval.id);
  }
  if (idx < 0) return [approval, ...list];
  const next = list.slice();
  next[idx] = approval;
  return next;
}

/** Prepends a new nudge (most recent first), deduplicated by id. */
export function prependNudge(list: NudgeDTO[] | undefined, nudge: NudgeDTO): NudgeDTO[] | undefined {
  if (!list) return list;
  if (list.some((n) => n.id === nudge.id)) return list;
  return [nudge, ...list];
}

/**
 * Keeps `ChannelDTO.lastMessage` (list preview) and `lastMessageAt` in sync with a created or updated message.
 * Only top-level messages become the preview; replies only bump `lastMessageAt`. An update replaces the
 * preview only when it is the same message (same author and creation time), e.g. the end of a streamed reply.
 */
export function applyLastMessage(list: ChannelDTO[] | undefined, msg: MessageDTO, kind: 'created' | 'updated' = 'created'): ChannelDTO[] | undefined {
  if (!list) return list;
  let changed = false;
  const next = list.map((c) => {
    if (c.id !== msg.channelId) return c;
    let out = c;
    if (kind === 'created' && (!c.lastMessageAt || c.lastMessageAt < msg.createdAt)) out = { ...out, lastMessageAt: msg.createdAt };
    if (!msg.threadRootId) {
      const cur = c.lastMessage;
      const preview = { content: msg.content, authorKind: msg.authorKind, botId: msg.botId, createdAt: msg.createdAt };
      const same = !!cur && cur.createdAt === msg.createdAt && cur.authorKind === msg.authorKind && cur.botId === msg.botId;
      const replace = kind === 'created' ? !cur || cur.createdAt <= msg.createdAt : same;
      if (replace && !(same && cur?.content === msg.content)) out = { ...out, lastMessage: preview };
    }
    if (out !== c) changed = true;
    return out;
  });
  return changed ? next : list;
}

export interface SnippetPart {
  text: string;
  match: boolean;
}

/** Splits a search snippet where matches are wrapped in « » (Postgres ts_headline StartSel/StopSel). */
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), match: false });
    if (m[1]) parts.push({ text: m[1], match: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts;
}
