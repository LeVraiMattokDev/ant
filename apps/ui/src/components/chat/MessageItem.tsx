import { memo } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquareReply } from 'lucide-react';
import { EFFORT_LABELS, MODEL_LABELS, type BotDTO, type MessageDTO } from '@ant/shared';
import { COMPUTE_SOURCE_LABELS } from '../../lib/labels';
import { formatFull, formatShort, formatTime, plural } from '../../lib/format';
import { Markdown } from '../Markdown';
import { Avatar, cx } from '../ui';
import { SystemMessage, isSystemStyled } from './SystemMessage';

const KIND_CHIPS: Partial<Record<NonNullable<MessageDTO['meta']['kind']>, string>> = {
  nudge: 'Relance',
  digest: 'Résumé quotidien',
  routine: 'Routine',
};

export function MessageChips({ message }: { message: MessageDTO }) {
  const { meta } = message;
  const chips: { key: string; text: string; title?: string; accent?: boolean }[] = [];
  const kindChip = meta.kind ? KIND_CHIPS[meta.kind] : undefined;
  if (kindChip) chips.push({ key: 'kind', text: kindChip, accent: true });
  if (meta.model) chips.push({ key: 'model', text: MODEL_LABELS[meta.model] ?? meta.model, title: 'Modèle' });
  if (meta.effort) chips.push({ key: 'effort', text: `effort ${EFFORT_LABELS[meta.effort] ?? meta.effort}`, title: 'Niveau d’effort' });
  if (meta.computeSource) chips.push({ key: 'source', text: COMPUTE_SOURCE_LABELS[meta.computeSource], title: 'Source de calcul' });
  if (meta.computeSource === 'api' && typeof meta.costUsd === 'number') {
    chips.push({ key: 'cost', text: `$${meta.costUsd.toFixed(4)}`, title: 'Coût estimé en crédits API' });
  }
  if (!chips.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c.key} title={c.title} className={cx('chip', c.accent && 'border-transparent bg-accent-soft text-accent-text')}>
          {c.text}
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

interface Props {
  message: MessageDTO;
  bot: BotDTO | undefined;
  bots: Map<string, BotDTO>;
  /** Hides avatar and name when the previous message is from the same author a few minutes earlier. */
  grouped?: boolean;
  /** Shows the "N réponses" link (top-level messages only). */
  threadLink?: string | null;
  highlighted?: boolean;
}

export const MessageItem = memo(function MessageItem({ message, bot, bots, grouped = false, threadLink, highlighted }: Props) {
  if (isSystemStyled(message)) {
    return (
      <div id={`msg-${message.id}`} className={cx('px-4 py-1 md:px-5', highlighted && 'highlight-flash rounded-[6px]')}>
        <SystemMessage message={message} bots={bots} />
        {threadLink && message.replyCount > 0 && <ThreadLink to={threadLink} message={message} />}
      </div>
    );
  }

  const isUser = message.authorKind === 'user';
  const name = isUser ? 'Toi' : (bot?.name ?? 'Bot supprimé');

  return (
    <div
      id={`msg-${message.id}`}
      className={cx(
        'group relative flex gap-3 px-4 hover:bg-surface/60 md:px-5',
        grouped ? 'py-0.5' : 'pt-2.5 pb-0.5',
        highlighted && 'highlight-flash rounded-[6px]',
      )}
    >
      <div className="w-8 shrink-0">
        {!grouped &&
          (isUser ? (
            <span className="inline-flex size-8 items-center justify-center rounded-[5px] bg-accent-soft text-[12px] font-semibold text-accent-text">
              Toi
            </span>
          ) : bot ? (
            <Link to={`/bots/${bot.id}`} aria-label={`Profil de ${bot.name}`}>
              <Avatar emoji={bot.avatar} />
            </Link>
          ) : (
            <Avatar emoji="?" />
          ))}
        {grouped && (
          <time
            dateTime={message.createdAt}
            className="block pt-0.5 text-right text-[10.5px] text-subtle opacity-0 group-hover:opacity-100"
          >
            {formatTime(message.createdAt)}
          </time>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold">{name}</span>
            {bot && !isUser && <span className="text-[12px] text-subtle">@{bot.slug}</span>}
            <time dateTime={message.createdAt} title={formatFull(message.createdAt)} className="text-[11.5px] text-subtle">
              {formatShort(message.createdAt)}
            </time>
          </div>
        )}
        <div className="text-[14px]">
          {message.status === 'streaming' ? <StreamingBody content={message.content} /> : <Markdown source={message.content} />}
        </div>
        {message.status === 'error' && (
          <div className="mt-1 text-[12.5px] text-danger">La génération de cette réponse a échoué.</div>
        )}
        {!isUser && message.status !== 'streaming' && <MessageChips message={message} />}
        {threadLink && message.replyCount > 0 && <ThreadLink to={threadLink} message={message} />}
      </div>
      {threadLink && message.status !== 'streaming' && (
        <Link
          to={threadLink}
          aria-label="Répondre dans un fil"
          title="Répondre dans un fil"
          className="btn btn-sm btn-icon absolute top-1 right-3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-50"
        >
          <MessageSquareReply className="size-3.5" />
        </Link>
      )}
    </div>
  );
});

function ThreadLink({ to, message }: { to: string; message: MessageDTO }) {
  return (
    <Link
      to={to}
      className="mt-1 inline-flex items-center gap-2 rounded-[4px] px-1.5 py-0.5 text-[12.5px] font-medium text-accent-text hover:bg-accent-soft"
    >
      {plural(message.replyCount, 'réponse', 'réponses')}
      {message.lastReplyAt && <span className="font-normal text-subtle">dernière {formatShort(message.lastReplyAt)}</span>}
    </Link>
  );
}
