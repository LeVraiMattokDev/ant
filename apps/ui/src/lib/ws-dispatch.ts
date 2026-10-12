/** Applies a `ServerEvent` to the TanStack Query cache. Kept free of WebSocket concerns so it can be unit-tested. */
import type { QueryClient } from '@tanstack/react-query';
import type { ApprovalDTO, ChannelDTO, NudgeDTO, RunDTO, ServerEvent } from '@ant/shared';
import {
  appendDeltaToPages,
  appendDeltaToThread,
  applyApprovalUpdate,
  applyLastMessage,
  applyRunUpdate,
  bumpReplyCount,
  prependNudge,
  upsertChannelMessage,
  upsertRunInList,
  upsertThreadMessage,
  type MessagePages,
  type ThreadData,
} from './cache';
import { qk } from './queries';
import { pushToast } from './toast';

export interface DispatchHooks {
  /** Called for every nudge so the UI can surface it. */
  onNudge?: (nudge: NudgeDTO) => void;
}

export function dispatchServerEvent(qc: QueryClient, event: ServerEvent, hooks: DispatchHooks = {}): void {
  switch (event.type) {
    case 'message.created': {
      const m = event.message;
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
      if (m.threadRootId) {
        qc.setQueryData<ThreadData>(qk.thread(m.threadRootId), (d) => upsertThreadMessage(d, m));
      } else {
        qc.setQueryData<MessagePages>(qk.messages(m.channelId), (d) => upsertChannelMessage(d, m));
        qc.setQueryData<ThreadData>(qk.thread(m.id), (d) => upsertThreadMessage(d, m));
        qc.setQueryData<ChannelDTO[]>(qk.channels, (list) => applyLastMessage(list, m, 'updated'));
      }
      return;
    }
    case 'message.delta': {
      qc.setQueryData<MessagePages>(qk.messages(event.channelId), (d) => appendDeltaToPages(d, event.messageId, event.delta));
      qc.setQueriesData<ThreadData>({ queryKey: qk.threadAll }, (d) => appendDeltaToThread(d, event.messageId, event.delta));
      return;
    }
    case 'run.updated': {
      const run = event.run;
      qc.setQueryData<RunDTO[]>(qk.activeRuns, (d) => applyRunUpdate(d, run));
      for (const [key, list] of qc.getQueriesData<RunDTO[]>({ queryKey: qk.runsList })) {
        if (!list) continue;
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
