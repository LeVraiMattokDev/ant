import { useEffect, useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { BotDTO } from '@ant/shared';
import { plural } from '../../lib/format';
import { useThread } from '../../lib/queries';
import { ErrorBlock, LoadingBlock } from '../ui';
import { ActivityBar } from './ActivityBar';
import { Composer } from './Composer';
import { MessageItem } from './MessageItem';

export function ThreadPane({
  channelId,
  rootId,
  bots,
  members,
  onClose,
}: {
  channelId: string;
  rootId: string;
  bots: Map<string, BotDTO>;
  members: BotDTO[];
  onClose: () => void;
}) {
  const thread = useThread(rootId);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    nearBottom.current = true;
  }, [rootId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread.data]);

  return (
    <section
      aria-label="Fil de discussion"
      className="fixed inset-0 z-30 flex flex-col bg-bg md:static md:z-auto md:w-[400px] md:shrink-0 md:border-l md:border-line lg:w-[440px]"
    >
      <header className="safe-top flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <div>
          <h2 className="text-[14.5px] font-semibold">Fil</h2>
        </div>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Fermer le fil (Échap)">
          <X className="size-4" />
        </button>
      </header>
      {thread.isPending ? (
        <LoadingBlock />
      ) : thread.isError ? (
        <ErrorBlock error={thread.error} onRetry={() => void thread.refetch()} />
      ) : (
        <>
          <div
            ref={scroller}
            className="scroll-y min-h-0 flex-1 pb-3"
            role="log"
            aria-live="polite"
            onScroll={(e) => {
              const el = e.currentTarget;
              nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
            }}
          >
            <MessageItem message={thread.data.root} bot={thread.data.root.botId ? bots.get(thread.data.root.botId) : undefined} bots={bots} />
            <div className="flex items-center gap-3 px-5 py-2 text-[12px] text-subtle">
              <span>{plural(thread.data.replies.length, 'réponse', 'réponses')}</span>
              <div className="h-px flex-1 bg-line" />
            </div>
            {thread.data.replies.map((m) => (
              <MessageItem key={m.id} message={m} bot={m.botId ? bots.get(m.botId) : undefined} bots={bots} />
            ))}
          </div>
          <ActivityBar channelId={channelId} threadRootId={rootId} bots={bots} />
          <Composer channelId={channelId} threadRootId={rootId} members={members} placeholder="Répondre dans le fil…" compact />
        </>
      )}
    </section>
  );
}
