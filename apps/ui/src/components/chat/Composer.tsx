import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp } from 'lucide-react';
import type { BotDTO } from '@ant/shared';
import { toast } from '../../lib/toast';
import { Avatar, Spinner, cx } from '../ui';
import { applyMention, filterMentionCandidates, mentionAtCaret, type MentionQuery } from './mentions';
import { draftKey, getDraft, setDraft, useSendMessage } from './useSendMessage';

const MAX_HEIGHT = 240;

export function Composer({
  channelId,
  threadRootId = null,
  members,
  placeholder,
  autoFocus = true,
  compact = false,
}: {
  channelId: string;
  threadRootId?: string | null;
  members: BotDTO[];
  placeholder: string;
  autoFocus?: boolean;
  /** Narrow panes (thread) hide the keyboard hints. */
  compact?: boolean;
}) {
  const key = draftKey(channelId, threadRootId);
  const [text, setText] = useState(() => getDraft(key));
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = useSendMessage(channelId, threadRootId);
  const listId = useId();

  useEffect(() => {
    setText(getDraft(key));
    setMention(null);
    if (autoFocus && window.matchMedia('(min-width: 768px)').matches) ref.current?.focus();
  }, [key, autoFocus]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  const candidates = mention ? filterMentionCandidates(members, mention.query) : [];
  const showMentions = mention !== null && candidates.length > 0;

  const update = (value: string, caret: number) => {
    setText(value);
    setDraft(key, value);
    const m = mentionAtCaret(value, caret);
    setMention(m);
    if (m?.query !== mention?.query) setActive(0);
  };

  const pick = (bot: BotDTO) => {
    const el = ref.current;
    if (!mention || !el) return;
    const res = applyMention(text, mention, el.selectionStart ?? text.length, bot.slug);
    setText(res.text);
    setDraft(key, res.text);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(res.caret, res.caret);
    });
  };

  const submit = () => {
    const content = text.trim();
    if (!content || send.isPending) return;
    send.mutate(content, {
      onSuccess: () => {
        setText('');
        setDraft(key, '');
      },
      onError: (err) => toast.fromError(err, 'Message non envoyé'),
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (showMentions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const bot = candidates[active];
        if (bot) pick(bot);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="safe-bottom shrink-0 px-3 pt-1 pb-3 md:px-5">
      <div className="relative">
        {showMentions && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Bots du canal"
            className="absolute bottom-full left-0 z-20 mb-1 w-72 overflow-hidden rounded-[6px] border border-line bg-surface py-1 shadow-pop"
          >
            {candidates.map((b, i) => (
              <li
                key={b.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(b);
                }}
                onMouseEnter={() => setActive(i)}
                className={cx('flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px]', i === active && 'bg-hover')}
              >
                <Avatar emoji={b.avatar} size="sm" />
                <span className="font-medium">{b.name}</span>
                <span className="text-subtle">@{b.slug}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2 rounded-[6px] border border-line-strong bg-raised px-2 py-1.5 focus-within:border-accent focus-within:shadow-[0_0_0_2px_var(--ant-accent-soft)]">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-autocomplete="list"
            aria-controls={showMentions ? listId : undefined}
            aria-activedescendant={showMentions ? `${listId}-${active}` : undefined}
            onChange={(e) => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={onKeyDown}
            onClick={(e) => setMention(mentionAtCaret(text, e.currentTarget.selectionStart ?? text.length))}
            onBlur={() => setTimeout(() => setMention(null), 120)}
            className="max-h-[240px] min-h-[24px] flex-1 resize-none bg-transparent px-1 py-0.5 text-[14px] leading-[1.5] outline-none placeholder:text-subtle"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || send.isPending}
            aria-label="Envoyer"
            className="btn btn-primary btn-sm btn-icon shrink-0"
          >
            {send.isPending ? <Spinner className="size-3.5 text-accent-fg" /> : <ArrowUp className="size-4" />}
          </button>
        </div>
        <div className={cx('mt-1 hidden justify-between px-1 text-[11px] text-subtle', !compact && 'md:flex')}>
          <span>
            <span className="kbd">Entrée</span> envoyer · <span className="kbd">Maj</span>+<span className="kbd">Entrée</span> nouvelle ligne
          </span>
          {members.length > 1 && (
            <span>
              <span className="kbd">@</span> pour mentionner un bot
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
