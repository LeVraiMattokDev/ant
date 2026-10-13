import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUp, AtSign, CalendarClock, FolderOpen, Monitor, Plus } from 'lucide-react';
import type { BotDTO } from '@ant/shared';
import { TOUCH_QUERY, useMediaQuery } from '../../lib/hooks';
import { BotAvatar } from '../BotAvatar';
import { useShell } from '../layout/shell';
import { MenuItem, Popover } from '../Popover';
import { Spinner, cx } from '../ui';
import { applyMention, filterMentionCandidates, mentionAtCaret, type MentionQuery } from './mentions';
import { draftKey, getDraft, onMessageSent, setDraft, useSendMessage, useSendPending } from './useSendMessage';

const MAX_HEIGHT = 240;

export function Composer({
  channelId,
  threadRootId = null,
  members,
  placeholder,
  autoFocus = true,
  routineBotId,
  routineChannelId,
}: {
  channelId: string;
  threadRootId?: string | null;
  members: BotDTO[];
  placeholder: string;
  autoFocus?: boolean;
  /** Prefill of "Créer une routine" in the + menu. */
  routineBotId?: string;
  routineChannelId?: string;
}) {
  const navigate = useNavigate();
  const { openFiles, toggleComputer, computerOpen } = useShell();
  const key = draftKey(channelId, threadRootId);
  // The Composer stays mounted across conversations: callbacks of a send compare against the conversation shown now.
  const keyRef = useRef(key);
  keyRef.current = key;
  const [text, setText] = useState(() => getDraft(key));
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = useSendMessage();
  // A message still on its way from another conversation does not block this one; one of this conversation does,
  // even after a send elsewhere (it would otherwise be posted twice).
  const sending = useSendPending(channelId, threadRootId);
  // On a phone, Enter adds a line (no Shift+Enter on a touch keyboard); the button sends.
  const touch = useMediaQuery(TOUCH_QUERY);
  const listId = useId();

  // The draft of a sent conversation is cleared by useSendMessage. Empty the box only if it still shows that
  // conversation and the text that was sent (not text typed meanwhile, nor another conversation's draft).
  useEffect(
    () =>
      onMessageSent((sentKey, content) => {
        if (keyRef.current === sentKey) setText((t) => (t.trim() === content ? '' : t));
      }),
    [],
  );

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

  /** "Mentionner un bot": inserts "@" at the caret and opens the autocomplete. */
  const startMention = () => {
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const insert = before && !/[\s(]$/.test(before) ? ' @' : '@';
    const value = before + insert + text.slice(caret);
    const pos = caret + insert.length;
    setText(value);
    setDraft(key, value);
    setActive(0);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setMention(mentionAtCaret(value, pos));
    });
  };

  const submit = () => {
    const content = text.trim();
    if (!content || sending) return;
    // Success and failure are handled by useSendMessage for every send, not only the latest one.
    send.mutate({ content, channelId, threadRootId });
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
    // Touch keyboards: plain Enter falls through and inserts a newline; Ctrl/Cmd+Enter still sends (tablet keyboard).
    if (e.key === 'Enter' && !e.shiftKey && (!touch || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="safe-bottom shrink-0 px-3 pt-1 pb-3 md:px-6 md:pb-5">
      <div className="relative mx-auto w-full max-w-[880px]">
        {showMentions && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Bots de la conversation"
            className="menu-panel absolute bottom-full left-0 z-20 mb-2 w-72"
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
                className={cx('flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 text-[13.5px]', i === active && 'bg-hover')}
              >
                <BotAvatar bot={b} size={22} />
                <span className="font-medium">{b.name}</span>
                <span className="text-subtle">@{b.slug}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1.5 rounded-[24px] border border-line bg-surface p-1.5 shadow-[0_1px_2px_rgb(0_0_0/0.12)] transition-colors focus-within:border-line-strong">
          <Popover
            label="Actions"
            placement="top-start"
            trigger={(p) => (
              <button type="button" {...p} className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg" aria-label="Plus d’actions">
                <Plus className="size-[18px]" />
              </button>
            )}
          >
            {(close) => (
              <>
                {members.length > 1 && (
                  <MenuItem
                    icon={<AtSign />}
                    onSelect={() => {
                      close();
                      startMention();
                    }}
                  >
                    Mentionner un bot
                  </MenuItem>
                )}
                {routineBotId && (
                  <MenuItem
                    icon={<CalendarClock />}
                    onSelect={() => {
                      close();
                      const qs = new URLSearchParams({ new: '1', bot: routineBotId });
                      if (routineChannelId) qs.set('channel', routineChannelId);
                      navigate(`/routines?${qs.toString()}`);
                    }}
                  >
                    Créer une routine
                  </MenuItem>
                )}
                <MenuItem
                  icon={<FolderOpen />}
                  onSelect={() => {
                    close();
                    openFiles();
                  }}
                >
                  Parcourir les fichiers
                </MenuItem>
                <MenuItem
                  icon={<Monitor />}
                  onSelect={() => {
                    close();
                    toggleComputer();
                  }}
                >
                  {computerOpen ? 'Masquer l’ordinateur' : 'Ouvrir l’ordinateur'}
                </MenuItem>
              </>
            )}
          </Popover>
          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-autocomplete="list"
            aria-controls={showMentions ? listId : undefined}
            aria-activedescendant={showMentions ? `${listId}-${active}` : undefined}
            enterKeyHint={touch ? 'enter' : 'send'}
            onChange={(e) => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={onKeyDown}
            onClick={(e) => setMention(mentionAtCaret(text, e.currentTarget.selectionStart ?? text.length))}
            onBlur={() => setTimeout(() => setMention(null), 120)}
            className="max-h-[240px] min-h-[36px] flex-1 resize-none bg-transparent px-1 py-[7px] text-[14.5px] leading-[1.5] outline-none placeholder:text-subtle"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || sending}
            aria-label="Envoyer"
            title={touch ? 'Envoyer' : 'Envoyer (Entrée) · Maj+Entrée pour une nouvelle ligne'}
            className={cx(
              'flex size-9 shrink-0 items-center justify-center rounded-full transition-colors',
              text.trim() ? 'bg-primary text-primary-fg hover:opacity-90' : 'bg-active text-subtle',
            )}
          >
            {sending ? <Spinner className="size-4 text-current" /> : <ArrowUp className="size-[18px]" strokeWidth={2.4} />}
          </button>
        </div>
      </div>
    </div>
  );
}
