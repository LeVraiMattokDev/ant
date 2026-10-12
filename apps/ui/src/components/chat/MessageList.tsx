import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BotDTO, MessageDTO } from '@ant/shared';
import { flattenMessages } from '../../lib/cache';
import { formatDayHeader, isSameDay } from '../../lib/format';
import { useChannelMessages } from '../../lib/queries';
import { markRead } from '../../lib/unread';
import { ErrorBlock, LoadingBlock, Spinner } from '../ui';
import { KIND_CHIPS, MessageItem } from './MessageItem';
import { isSystemStyled } from './SystemMessage';

const NEAR_BOTTOM_PX = 140;
const GROUP_WINDOW_MS = 5 * 60_000;

function isGrouped(prev: MessageDTO | undefined, m: MessageDTO): boolean {
  if (!prev || isSystemStyled(prev) || isSystemStyled(m)) return false;
  if (prev.authorKind !== m.authorKind || prev.botId !== m.botId) return false;
  if (prev.replyCount > 0) return false;
  if (m.meta.kind && KIND_CHIPS[m.meta.kind]) return false;
  if (!isSameDay(prev.createdAt, m.createdAt)) return false;
  return new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
}

export function MessageList({
  channelId,
  bots,
  focusMessageId,
  empty,
}: {
  channelId: string;
  bots: Map<string, BotDTO>;
  /** Message to scroll to and highlight (search deep links). */
  focusMessageId?: string | null;
  empty: React.ReactNode;
}) {
  const query = useChannelMessages(channelId);
  const messages = useMemo(() => flattenMessages(query.data), [query.data]);
  const scroller = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const initialScrollDone = useRef(false);
  const focusAttempts = useRef(0);
  const [highlight, setHighlight] = useState<string | null>(null);

  // Reset per channel.
  useEffect(() => {
    nearBottom.current = true;
    initialScrollDone.current = false;
    focusAttempts.current = 0;
  }, [channelId]);

  const firstId = messages[0]?.id;
  const last = messages[messages.length - 1];

  // Keep the view anchored: after loading older messages, after new messages, during streaming.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restore.current) {
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top;
      restore.current = null;
      return;
    }
    if (!initialScrollDone.current && messages.length) {
      initialScrollDone.current = true;
      if (!focusMessageId) el.scrollTop = el.scrollHeight;
      return;
    }
    if (nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, firstId, focusMessageId]);

  // Content can grow without new messages (inline approval cards, images): stay pinned to the bottom.
  useEffect(() => {
    const el = content.current;
    const root = scroller.current;
    if (!el || !root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current && !restore.current) root.scrollTop = root.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [channelId, query.isPending, messages.length > 0]);

  // Infinite scroll upwards.
  useEffect(() => {
    const el = topSentinel.current;
    const root = scroller.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (!query.hasNextPage || query.isFetchingNextPage || !initialScrollDone.current) return;
        restore.current = { height: root.scrollHeight, top: root.scrollTop };
        void query.fetchNextPage();
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [query, channelId]);

  // Deep link to a message: load older pages until it is found (bounded), then scroll to it.
  useEffect(() => {
    if (!focusMessageId || query.isPending) return;
    const node = document.getElementById(`msg-${focusMessageId}`);
    if (node) {
      node.scrollIntoView({ block: 'center' });
      setHighlight(focusMessageId);
      nearBottom.current = false;
      return;
    }
    if (query.hasNextPage && !query.isFetchingNextPage && focusAttempts.current < 10) {
      focusAttempts.current++;
      void query.fetchNextPage();
    }
  }, [focusMessageId, messages, query]);

  // Read marks.
  useEffect(() => {
    if (last && document.visibilityState === 'visible') markRead(channelId, last.createdAt);
  }, [channelId, last]);

  if (query.isPending) return <LoadingBlock label="Chargement des messages…" />;
  if (query.isError) return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <div
      ref={scroller}
      className="scroll-y min-h-0 flex-1"
      onScroll={(e) => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      }}
      role="log"
      aria-label="Messages"
      aria-live="polite"
    >
      <div ref={topSentinel} className="h-px" />
      {query.isFetchingNextPage && (
        <div className="flex justify-center py-3">
          <Spinner />
        </div>
      )}
      {!query.hasNextPage && messages.length > 0 && (
        <div className="px-5 pt-8 pb-1 text-center text-[12px] text-subtle">Début de la conversation</div>
      )}
      {messages.length === 0 ? (
        empty
      ) : (
        <div ref={content} className="mx-auto w-full max-w-[880px] pb-6">
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || !isSameDay(prev.createdAt, m.createdAt);
            return (
              <Fragment key={m.id}>
                {newDay && (
                  <div className="flex justify-center px-5 pt-6 pb-1" role="separator" aria-label={formatDayHeader(m.createdAt)}>
                    <span className="rounded-full px-3 py-0.5 text-[11.5px] font-medium text-subtle">
                      {formatDayHeader(m.createdAt)}
                    </span>
                  </div>
                )}
                <MessageItem
                  message={m}
                  bot={m.botId ? bots.get(m.botId) : undefined}
                  bots={bots}
                  grouped={!newDay && isGrouped(prev, m)}
                  threadLink={`/c/${channelId}/t/${m.id}`}
                  highlighted={highlight === m.id}
                />
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
