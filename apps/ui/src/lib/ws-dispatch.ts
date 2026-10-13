/** Applies a `ServerEvent` to the TanStack Query cache. Kept free of WebSocket concerns so it can be unit-tested. */
import type { QueryClient } from '@tanstack/react-query';
import type { ApprovalDTO, ChannelDTO, NudgeDTO, RunDTO, ServerEvent } from '@ant/shared';
import { dispatchFeatureEvent } from '../features';
import {
  appendDeltaToPages,
  appendDeltaToThread,
  applyApprovalUpdate,
  applyChannelMessageUpdate,
  applyChunksToPages,
  applyChunksToThread,
  applyLastMessage,
  applyRunUpdate,
  bumpReplyCount,
  prependNudge,
  upsertChannelMessage,
  upsertRunInList,
  upsertThreadMessage,
  type MessagePages,
  type StreamChunk,
  type ThreadData,
} from './cache';
import { qk } from './queries';
import { pushToast } from './toast';

export interface DispatchHooks {
  /** Called for every nudge so the UI can surface it. */
  onNudge?: (nudge: NudgeDTO) => void;
}

/** At most one refetch per streamed message in this interval when its text has a gap. */
const GAP_REFETCH_MS = 2_000;
const MAX_STREAM_CHUNKS = 2_000;
const STALE_STREAM_MS = 10 * 60_000;

interface StreamBuffer {
  /** Chunks received since the last full version of the message, sorted by offset. */
  chunks: StreamChunk[];
  touched: number;
  lastRefetch: number;
}

/**
 * Chunks of the replies being streamed, kept until the next full version of the message (`message.updated`).
 * A cache filled by a fetch (first open, reconnection, refetch) holds the text saved in the database, which can
 * lag behind the broadcast chunks: re-applying the buffer fills it back without losing a passage.
 */
const streams = new Map<string, StreamBuffer>();

function bufferChunk(messageId: string, chunk: StreamChunk, now: number): StreamBuffer {
  let buf = streams.get(messageId);
  if (!buf) {
    // Replies whose final update never arrived (socket down at that moment) are forgotten after a while.
    for (const [id, b] of streams) if (now - b.touched > STALE_STREAM_MS) streams.delete(id);
    buf = { chunks: [], touched: now, lastRefetch: 0 };
    streams.set(messageId, buf);
  }
  buf.touched = now;
  const { chunks } = buf;
  let i = chunks.length;
  while (i > 0 && chunks[i - 1]!.offset > chunk.offset) i--;
  const prev = chunks[i - 1];
  if (!prev || prev.offset !== chunk.offset || prev.delta !== chunk.delta) chunks.splice(i, 0, chunk);
  if (chunks.length > MAX_STREAM_CHUNKS) chunks.splice(0, chunks.length - MAX_STREAM_CHUNKS);
  return buf;
}

function applyDelta(qc: QueryClient, event: Extract<ServerEvent, { type: 'message.delta' }>): void {
  const { messageId, channelId, delta, offset } = event;
  if (offset === undefined) {
    qc.setQueryData<MessagePages>(qk.messages(channelId), (d) => appendDeltaToPages(d, messageId, delta));
    qc.setQueriesData<ThreadData>({ queryKey: qk.threadAll }, (d) => appendDeltaToThread(d, messageId, delta));
    return;
  }
  const now = Date.now();
  const buf = bufferChunk(messageId, { offset, delta }, now);
  const gaps: (readonly unknown[])[] = [];
  const pagesKey = qk.messages(channelId);
  qc.setQueryData<MessagePages>(pagesKey, (d) => applyChunksToPages(d, messageId, buf.chunks, () => gaps.push(pagesKey)));
  for (const [key, data] of qc.getQueriesData<ThreadData>({ queryKey: qk.threadAll })) {
    if (data) qc.setQueryData<ThreadData>(key, (d) => applyChunksToThread(d, messageId, buf.chunks, () => gaps.push(key)));
  }
  // Text is missing before the received chunks: fetch it again, without restarting a fetch already in flight.
  if (gaps.length && now - buf.lastRefetch >= GAP_REFETCH_MS) {
    buf.lastRefetch = now;
    for (const key of gaps) void qc.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
  }
}

export function dispatchServerEvent(qc: QueryClient, event: ServerEvent, hooks: DispatchHooks = {}): void {
  applyCoreEvent(qc, event, hooks);
  // Feature modules (features/*): the event types added for them are only handled there.
  dispatchFeatureEvent(qc, event);
}

function applyCoreEvent(qc: QueryClient, event: ServerEvent, hooks: DispatchHooks): void {
  switch (event.type) {
    case 'message.created': {
      const m = event.message;
      streams.delete(m.id);
      if (m.threadRootId) {
        qc.setQueryData<MessagePages>(qk.messages(m.channelId), (d) => bumpReplyCount(d, m));
        qc.setQueryData<ThreadData>(qk.thread(m.threadRootId), (d) => upsertThreadMessage(d, m));
      } else {
        qc.setQueryData<MessagePages>(qk.messages(m.channelId), (d) => upsertChannelMessage(d, m));
      }
      qc.setQueryData<ChannelDTO[]>(qk.channels, (list) => applyLastMessage(list, m, 'created'));
      return;
    }
    case 'message.updated': {
      const m = event.message;
      // A full version of the message: chunks received before it no longer apply (a new attempt restarts from its text).
      streams.delete(m.id);
      if (m.threadRootId) {
        qc.setQueryData<ThreadData>(qk.thread(m.threadRootId), (d) => upsertThreadMessage(d, m));
      } else {
        // Replaced when loaded. Otherwise added only inside the loaded window (its creation was lost in a fetch race);
        // an old message not loaded (e.g. a thread root getting a reply) stays out of the newest page.
        qc.setQueryData<MessagePages>(qk.messages(m.channelId), (d) => applyChannelMessageUpdate(d, m));
        qc.setQueryData<ThreadData>(qk.thread(m.id), (d) => upsertThreadMessage(d, m));
        qc.setQueryData<ChannelDTO[]>(qk.channels, (list) => applyLastMessage(list, m, 'updated'));
      }
      return;
    }
    case 'message.delta':
      applyDelta(qc, event);
      return;
    case 'run.updated': {
      const run = event.run;
      qc.setQueryData<RunDTO[]>(qk.activeRuns, (d) => applyRunUpdate(d, run));
      for (const [key, list] of qc.getQueriesData<RunDTO[]>({ queryKey: qk.runsList })) {
        if (!list) continue;
        // Key: ['runs', 'list', botId | null, limit | null]. A list filtered to another bot can never contain this run.
        const botFilter = key[2];
        if (botFilter != null && botFilter !== run.botId) continue;
        if (list.some((r) => r.id === run.id)) qc.setQueryData<RunDTO[]>(key, (d) => upsertRunInList(d, run));
        else void qc.invalidateQueries({ queryKey: key, exact: true });
      }
      return;
    }
    case 'approval.updated': {
      const a: ApprovalDTO = event.approval;
      qc.setQueryData<ApprovalDTO[]>(qk.approvals('pending'), (d) => applyApprovalUpdate(d, a, true));
      qc.setQueryData<ApprovalDTO[]>(qk.approvals('all'), (d) => applyApprovalUpdate(d, a, false));
      void qc.invalidateQueries({ queryKey: qk.approvalsAll });
      return;
    }
    case 'quota.updated':
      void qc.invalidateQueries({ queryKey: qk.quota });
      return;
    case 'memory.updated':
      void qc.invalidateQueries({ queryKey: qk.memoryAll });
      return;
    case 'tasks.updated':
      void qc.invalidateQueries({ queryKey: qk.tasksAll });
      return;
    case 'routines.updated':
      void qc.invalidateQueries({ queryKey: qk.routines });
      return;
    case 'bot.updated':
      void qc.invalidateQueries({ queryKey: qk.bots });
      return;
    case 'channel.updated':
      void qc.invalidateQueries({ queryKey: qk.channels });
      return;
    case 'nudge.created': {
      const n = event.nudge;
      for (const [key] of qc.getQueriesData<NudgeDTO[]>({ queryKey: qk.nudgesAll })) {
        const botFilter = key[1];
        if (botFilter === null || botFilter === n.botId) qc.setQueryData<NudgeDTO[]>(key, (d) => prependNudge(d, n));
      }
      hooks.onNudge?.(n);
      return;
    }
    case 'computer.updated':
      qc.setQueryData(qk.computerStatus, event.status);
      return;
    case 'toast':
      pushToast({ level: event.level, title: event.title, body: event.body, url: event.url });
      return;
  }
}
