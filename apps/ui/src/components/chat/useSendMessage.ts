import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import type { ChannelDTO, MessageDTO, RunDTO } from '@ant/shared';
import { post } from '../../lib/api';
import { applyLastMessage, applyRunUpdate, upsertChannelMessage, upsertThreadMessage, type MessagePages, type ThreadData } from '../../lib/cache';
import { qk } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { markRead } from '../../lib/unread';

export interface SendInput {
  content: string;
  channelId: string;
  threadRootId: string | null;
}

const SEND_KEY = ['messages', 'send'] as const;

type SentListener = (key: string, content: string) => void;
const sentListeners = new Set<SentListener>();

/**
 * Called when a send lands, with the draft key of its conversation and the text sent, so a box showing that
 * conversation can empty itself whichever Composer, render or call started the send.
 */
export function onMessageSent(listener: SentListener): () => void {
  sentListeners.add(listener);
  return () => {
    sentListeners.delete(listener);
  };
}

/**
 * Sends a message. The conversation travels with each call and the cache is updated from the server's answer:
 * the Composer stays mounted when the owner switches conversations, and TanStack hands a pending mutation the
 * latest render's options, so nothing here may rely on the conversation shown when the answer arrives.
 * Everything that must happen for every send lives here, at hook level: TanStack calls the callbacks given to
 * `mutate` only for the latest call, and a send in another conversation can start while one is still pending.
 */
export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: SEND_KEY,
    mutationFn: ({ content, channelId, threadRootId }: SendInput) =>
      post<{ message: MessageDTO; runs: RunDTO[] }>(`/api/channels/${channelId}/messages`, { content, threadRootId }),
    onSuccess: ({ message, runs }, input) => {
      if (message.threadRootId) {
        qc.setQueryData<ThreadData>(qk.thread(message.threadRootId), (d) => upsertThreadMessage(d, message));
      } else {
        qc.setQueryData<MessagePages>(qk.messages(message.channelId), (d) => upsertChannelMessage(d, message));
      }
      qc.setQueryData<ChannelDTO[]>(qk.channels, (list) => applyLastMessage(list, message, 'created'));
      qc.setQueryData<RunDTO[]>(qk.activeRuns, (d) => runs.reduce<RunDTO[] | undefined>((acc, r) => applyRunUpdate(acc, r), d));
      markRead(message.channelId, message.createdAt);
      // The sent text leaves the draft of its own conversation, even if the Composer moved on or unmounted.
      // A draft edited since then is kept.
      const key = draftKey(input.channelId, input.threadRootId);
      if (getDraft(key).trim() === input.content) setDraft(key, '');
      for (const listener of sentListeners) listener(key, input.content);
    },
    // The text stays in its draft: the owner finds it back in the box of that conversation.
    onError: (err) => toast.fromError(err, 'Message non envoyé'),
  });
}

/** Whether a send of this conversation is still on its way, even when other sends were started after it. */
export function useSendPending(channelId: string, threadRootId: string | null): boolean {
  // Fixed filters: useMutationState only re-reads them on a mutation event, not when the conversation changes.
  const pending = useMutationState({
    filters: { mutationKey: SEND_KEY, status: 'pending' },
    select: (m) => m.state.variables as SendInput | undefined,
  });
  return pending.some((v) => v?.channelId === channelId && v.threadRootId === threadRootId);
}

/** Drafts survive navigation between channels during the session. */
const drafts = new Map<string, string>();
export const draftKey = (channelId: string, threadRootId: string | null) => `${channelId}:${threadRootId ?? ''}`;
export const getDraft = (key: string) => drafts.get(key) ?? '';
export const setDraft = (key: string, value: string) => {
  if (value) drafts.set(key, value);
  else drafts.delete(key);
};
