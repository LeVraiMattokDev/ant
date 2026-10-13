import { memo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, Copy, Link2, MessageSquareReply, MessagesSquare, MoreHorizontal } from 'lucide-react';
import { EFFORT_LABELS, MODEL_LABELS, type BotDTO, type MessageDTO } from '@ant/shared';
import { FeatureMessageExtras, FeatureMessageMenuItems } from '../../features';
import { copyText } from '../../lib/clipboard';
import { useMediaQuery } from '../../lib/hooks';
import { COMPUTE_SOURCE_LABELS } from '../../lib/labels';
import { formatFull, formatShort, formatTime, plural } from '../../lib/format';
import { toast } from '../../lib/toast';
import { BotAvatar } from '../BotAvatar';
import { Markdown } from '../Markdown';
import { MenuItem, Popover } from '../Popover';
import { cx } from '../ui';
import { SystemMessage, isSystemStyled } from './SystemMessage';

export const KIND_CHIPS: Partial<Record<NonNullable<MessageDTO['meta']['kind']>, string>> = {
  nudge: 'Relance',
  digest: 'Résumé quotidien',
  routine: 'Routine',
  watch: 'Veille',
};

/** Model, effort, compute source and (API only) cost of a bot reply. */
export function MessageChips({ message, className }: { message: MessageDTO; className?: string }) {
  const { meta } = message;
  const parts: { key: string; text: string; title: string; strong?: boolean }[] = [];
  if (meta.model) parts.push({ key: 'model', text: MODEL_LABELS[meta.model] ?? meta.model, title: 'Modèle' });
  if (meta.effort) parts.push({ key: 'effort', text: `effort ${EFFORT_LABELS[meta.effort] ?? meta.effort}`, title: 'Niveau d’effort' });
  if (meta.computeSource) parts.push({ key: 'source', text: COMPUTE_SOURCE_LABELS[meta.computeSource], title: 'Source de calcul', strong: meta.computeSource === 'api' });
  if (meta.computeSource === 'api' && typeof meta.costUsd === 'number') {
    parts.push({ key: 'cost', text: `$${meta.costUsd.toFixed(4)}`, title: 'Coût estimé en crédits API', strong: true });
  }
  if (!parts.length) return null;
  return (
    <div className={cx('flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-subtle', className)}>
      {parts.map((p, i) => (
        <span key={p.key} title={p.title} className={cx(p.strong && 'text-muted')}>
          {i > 0 && <span aria-hidden="true" className="mr-1.5 text-line-strong">·</span>}
          {p.text}
        </span>
      ))}
    </div>
  );
}

function StreamingBody({ content }: { content: string }) {
  if (!content) {
    return (
      <div className="flex h-5 items-center gap-1 text-subtle" aria-label="Réponse en cours">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    );
  }
  return <Markdown source={content} className="streaming-caret" />;
}

function messageUrl(m: MessageDTO): string {
  const path = m.threadRootId ? `/c/${m.channelId}/t/${m.threadRootId}` : `/c/${m.channelId}?m=${m.id}`;
  return `${window.location.origin}${path}`;
}

const actionBtn =
  'flex size-7 items-center justify-center rounded-[8px] text-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:opacity-100';

/** Reply in thread, copy, and "···" (open thread, copy link). Shown on hover, always on touch screens. */
function MessageActions({ message, threadLink, className }: { message: MessageDTO; threadLink?: string | null; className?: string }) {
  const navigate = useNavigate();
  const touch = useMediaQuery('(hover: none)');
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void copyText(message.content).then((ok) => {
      if (!ok) {
        toast.error('Copie impossible', 'Le navigateur a refusé l’accès au presse-papiers.');
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div
      className={cx(
        'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-60',
        className,
      )}
    >
      {threadLink && !touch && (
        <Link to={threadLink} className={actionBtn} aria-label="Répondre dans un fil" title="Répondre dans un fil">
          <MessageSquareReply className="size-4" />
        </Link>
      )}
      {!touch && (
        <button type="button" className={actionBtn} onClick={copy} aria-label={copied ? 'Copié' : 'Copier'} title="Copier le texte">
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </button>
      )}
      <Popover
        label="Autres actions"
        placement="bottom-end"
        trigger={(p) => (
          <button type="button" {...p} className={actionBtn} aria-label="Autres actions" title="Autres actions">
            <MoreHorizontal className="size-4" />
          </button>
        )}
      >
        {(close) => (
          <>
            {touch && threadLink && (
              <MenuItem
                icon={<MessageSquareReply />}
                onSelect={() => {
                  close();
                  navigate(threadLink);
                }}
              >
                Répondre dans un fil
              </MenuItem>
            )}
            {touch && (
              <MenuItem
                icon={<Copy />}
                onSelect={() => {
                  close();
                  copy();
                }}
              >
                Copier le texte
              </MenuItem>
            )}
            {threadLink && (!touch || message.replyCount > 0) && (
              <MenuItem
                icon={<MessagesSquare />}
                hint={message.replyCount > 0 ? String(message.replyCount) : undefined}
                onSelect={() => {
                  close();
                  navigate(threadLink);
                }}
              >
                Ouvrir le fil
              </MenuItem>
            )}
            <MenuItem
              icon={<Link2 />}
              onSelect={() => {
                close();
                void copyText(messageUrl(message)).then((ok) =>
                  ok ? toast.success('Lien copié') : toast.error('Copie impossible', 'Le navigateur a refusé l’accès au presse-papiers.'),
                );
              }}
            >
              Copier le lien
            </MenuItem>
            <FeatureMessageMenuItems message={message} close={close} />
          </>
        )}
      </Popover>
    </div>
  );
}

function ThreadLink({ to, message, align = 'start' }: { to: string; message: MessageDTO; align?: 'start' | 'end' }) {
  return (
    <Link
      to={to}
      className={cx(
        'mt-1.5 inline-flex items-center gap-2 rounded-full border border-line px-2.5 py-1 text-[12.5px] font-medium text-accent-text transition-colors hover:bg-hover',
        align === 'end' && 'self-end',
      )}
    >
      <MessagesSquare className="size-3.5" />
      {plural(message.replyCount, 'réponse', 'réponses')}
      {message.lastReplyAt && <span className="font-normal text-subtle">· {formatShort(message.lastReplyAt)}</span>}
    </Link>
  );
}

interface Props {
  message: MessageDTO;
  bot: BotDTO | undefined;
  bots: Map<string, BotDTO>;
  /** Continues a run of messages from the same author: no name/time header. */
  grouped?: boolean;
  /** Thread route of this message (top-level messages only). */
  threadLink?: string | null;
  highlighted?: boolean;
}

export const MessageItem = memo(function MessageItem({ message, bot, bots, grouped = false, threadLink, highlighted }: Props) {
  if (isSystemStyled(message)) {
    return (
      <div id={`msg-${message.id}`} className={cx('flex flex-col items-center px-4 py-2 md:px-6', highlighted && 'highlight-flash rounded-[14px]')}>
        <SystemMessage message={message} bots={bots} />
        <FeatureMessageExtras message={message} />
        {threadLink && message.replyCount > 0 && <ThreadLink to={threadLink} message={message} />}
      </div>
    );
  }

  const streaming = message.status === 'streaming';
  const body = streaming ? <StreamingBody content={message.content} /> : <Markdown source={message.content} />;
  const error = message.status === 'error' && <div className="mt-1.5 text-[12.5px] text-danger">La génération de cette réponse a échoué.</div>;

  if (message.authorKind === 'user') {
    return (
      <div id={`msg-${message.id}`} className={cx('group flex flex-col items-end px-4 md:px-6', grouped ? 'pt-1.5' : 'pt-5')}>
        <div className="flex max-w-[min(85%,640px)] items-center gap-1.5">
          {!streaming && <MessageActions message={message} threadLink={threadLink} />}
          <div
            className={cx('min-w-0 rounded-[20px] bg-bubble px-4 py-2.5 text-[14px] leading-[1.55]', highlighted && 'highlight-flash')}
            title={formatFull(message.createdAt)}
          >
            {body}
          </div>
        </div>
        {error}
        <FeatureMessageExtras message={message} />
        <time dateTime={message.createdAt} className="mt-1 pr-2 text-[11px] text-subtle opacity-0 transition-opacity group-hover:opacity-100">
          {formatShort(message.createdAt)}
        </time>
        {threadLink && message.replyCount > 0 && <ThreadLink to={threadLink} message={message} align="end" />}
      </div>
    );
  }

  const name = bot?.name ?? 'Bot supprimé';
  const kindChip = message.meta.kind ? KIND_CHIPS[message.meta.kind] : undefined;
  const showMeta = message.meta.computeSource === 'api';
  return (
    <div id={`msg-${message.id}`} className={cx('group px-4 md:px-6', grouped ? 'pt-1.5' : 'pt-5')}>
      {!grouped && (
        <div className="mb-1.5 flex items-center gap-2 pl-1">
          {bot ? (
            <Link to={`/bots/${bot.id}`} aria-label={`Profil de ${bot.name}`} className="rounded-full">
              <BotAvatar bot={bot} size={20} />
            </Link>
          ) : (
            <BotAvatar bot={undefined} size={20} />
          )}
          <span className="text-[13px] font-semibold">{name}</span>
          <time dateTime={message.createdAt} title={formatFull(message.createdAt)} className="text-[11.5px] text-subtle">
            {formatShort(message.createdAt)}
          </time>
          {kindChip && <span className="chip !h-[18px] bg-accent-soft !text-accent-text">{kindChip}</span>}
        </div>
      )}
      <div className="flex items-start gap-1.5">
        <div
          className={cx(
            'w-fit max-w-[min(100%,720px)] min-w-0 rounded-[18px] bg-card px-4 py-3 text-[14px] leading-[1.6]',
            highlighted && 'highlight-flash',
          )}
          title={grouped ? formatTime(message.createdAt) : undefined}
        >
          {body}
          {error}
        </div>
        {!streaming && <MessageActions message={message} threadLink={threadLink} className="sticky top-2 mt-1" />}
      </div>
      {!streaming && <FeatureMessageExtras message={message} />}
      {!streaming && (
        <MessageChips
          message={message}
          className={cx('mt-1.5 pl-1.5', !showMeta && 'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100')}
        />
      )}
      {threadLink && message.replyCount > 0 && <ThreadLink to={threadLink} message={message} />}
    </div>
  );
});
