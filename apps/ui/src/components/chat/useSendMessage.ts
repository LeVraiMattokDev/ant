import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ChannelDTO, MessageDTO, RunDTO } from '@ant/shared';
import { post } from '../../lib/api';
import { applyLastMessage, applyRunUpdate, upsertChannelMessage, upsertThreadMessage, type MessagePages, type ThreadData } from '../../lib/cache';
import { qk } from '../../lib/queries';
import { markRead } from '../../lib/unread';

export function useSendMessage(channelId: string, threadRootId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      post<{ message: MessageDTO; runs: RunDTO[] }>(`/api/channels/${channelId}/messages`, { content, threadRootId }),
    onSuccess: ({ message, runs }) => {
      if (message.threadRootId) {
        qc.setQueryData<ThreadData>(qk.thread(message.threadRootId), (d) => upsertThreadMessage(d, message));
      } else {
        qc.setQueryData<MessagePages>(qk.messages(channelId), (d) => upsertChannelMessage(d, message));
      }
      qc.setQueryData<ChannelDTO[]>(qk.channels, (list) => applyLastMessage(list, message, 'created'));
      qc.setQueryData<RunDTO[]>(qk.activeRuns, (d) => runs.reduce<RunDTO[] | undefined>((acc, r) => applyRunUpdate(acc, r), d));
      markRead(channelId, message.createdAt);
    },
  });
}

/** Drafts survive navigation between channels during the session. */
const drafts = new Map<string, string>();
export const draftKey = (channelId: string, threadRootId: string | null) => `${channelId}:${threadRootId ?? ''}`;
export const getDraft = (key: string) => drafts.get(key) ?? '';
export const setDraft = (key: string, value: string) => {
  if (value) drafts.set(key, value);
  else drafts.delete(key);
};
