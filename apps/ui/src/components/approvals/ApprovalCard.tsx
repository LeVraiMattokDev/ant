import { useState } from 'react';
import { Link } from 'react-router-dom';
import { APPROVAL_CATEGORY_LABELS, type ApprovalDTO, type ApprovalStatus, type BotDTO } from '@ant/shared';
import { APPROVAL_STATUS_LABELS } from '../../lib/labels';
import { formatFull, formatRelative } from '../../lib/format';
import { Markdown } from '../Markdown';
import { Badge, Spinner, cx } from '../ui';
import { useDecideApproval } from './useDecideApproval';
import { BotAvatar } from '../BotAvatar';

const STATUS_TONE: Record<ApprovalStatus, 'accent' | 'success' | 'danger' | 'neutral' | 'info' | 'warning'> = {
  pending: 'accent',
  approved: 'info',
  executed: 'success',
  rejected: 'danger',
  failed: 'danger',
  expired: 'neutral',
};

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{APPROVAL_STATUS_LABELS[status]}</Badge>;
}

export function ApprovalCard({
  approval,
  bot,
  compact = false,
  highlighted = false,
}: {
  approval: ApprovalDTO;
  bot: BotDTO | undefined;
  compact?: boolean;
  highlighted?: boolean;
}) {
  const decide = useDecideApproval();
  const [comment, setComment] = useState('');
  const [pendingDecision, setPendingDecision] = useState<'approve' | 'reject' | null>(null);
  const pending = approval.status === 'pending';
  const expired = pending && new Date(approval.expiresAt).getTime() < Date.now();

  const submit = (decision: 'approve' | 'reject') => {
    setPendingDecision(decision);
    decide.mutate(
      { id: approval.id, decision, comment: comment.trim() || undefined },
      { onSettled: () => setPendingDecision(null), onSuccess: () => setComment('') },
    );
  };

  return (
    <article
      id={`approval-${approval.id}`}
      aria-label={`Validation : ${approval.title}`}
      className={cx(
        'card overflow-hidden',
        pending && 'border-accent/50',
        highlighted && 'highlight-flash',
      )}
    >
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">{APPROVAL_CATEGORY_LABELS[approval.category] ?? approval.category}</Badge>
            {approval.urgent && <Badge tone="danger">Urgent</Badge>}
            <ApprovalStatusBadge status={approval.status} />
          </div>
          <h3 className="mt-1.5 text-[14.5px] font-semibold leading-snug">{approval.title}</h3>
        </div>
        {bot && (
          <Link to={`/bots/${bot.id}`} className="flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
            <BotAvatar bot={bot} size={20} />
            {bot.name}
          </Link>
        )}
      </header>

      <div className="space-y-3 px-3 py-3">
        {approval.summary && <Markdown source={approval.summary} className="text-[13.5px]" />}

        {approval.hasScreenshot && (
          <a href={`/api/approvals/${approval.id}/screenshot`} target="_blank" rel="noreferrer" className="block">
            <img
              src={`/api/approvals/${approval.id}/screenshot`}
              alt={`Capture d’écran pour « ${approval.title} »`}
              loading="lazy"
              className={cx('w-full rounded-[8px] border border-line object-contain object-top', compact ? 'max-h-48' : 'max-h-96')}
            />
          </a>
        )}

        <details className="group rounded-[8px] border border-line bg-bg">
          <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[12.5px] text-muted hover:text-fg">
            Paramètres exacts <span className="mono text-subtle">({approval.tool})</span>
          </summary>
          <pre className="mono max-h-80 overflow-auto border-t border-line px-2.5 py-2 text-[12px] leading-relaxed whitespace-pre-wrap">
            {JSON.stringify(approval.payload, null, 2)}
          </pre>
        </details>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-subtle">
          <span title={formatFull(approval.createdAt)}>Demandée {formatRelative(approval.createdAt)}</span>
          {pending ? (
            <span title={formatFull(approval.expiresAt)} className={expired ? 'text-danger' : undefined}>
              {expired ? 'Expirée' : `Expire ${formatRelative(approval.expiresAt)}`}
            </span>
          ) : (
            approval.decidedAt && <span title={formatFull(approval.decidedAt)}>Décidée {formatRelative(approval.decidedAt)}</span>
          )}
          {approval.channelId && (
            <Link to={`/c/${approval.channelId}`} className="underline-offset-2 hover:text-fg hover:underline">
              Voir la conversation
            </Link>
          )}
        </div>

        {!pending && (approval.comment || approval.result) && (
          <div className="space-y-1 rounded-[8px] bg-raised px-2.5 py-2 text-[13px]">
            {approval.comment && (
              <div>
                <span className="text-muted">Ton commentaire : </span>
                {approval.comment}
              </div>
            )}
            {approval.result && (
              <div>
                <span className="text-muted">Résultat : </span>
                <span className="whitespace-pre-wrap">{approval.result}</span>
              </div>
            )}
          </div>
        )}

        {pending && (
          <div className="space-y-2">
            <label className="sr-only" htmlFor={`comment-${approval.id}`}>
              Commentaire pour le bot
            </label>
            <textarea
              id={`comment-${approval.id}`}
              className="textarea min-h-[36px] text-[13px]"
              rows={compact ? 1 : 2}
              placeholder="Commentaire pour le bot (facultatif)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary" disabled={decide.isPending} onClick={() => submit('approve')}>
                {pendingDecision === 'approve' && <Spinner className="size-4 text-accent-fg" />}
                Approuver
              </button>
              <button type="button" className="btn btn-danger" disabled={decide.isPending} onClick={() => submit('reject')}>
                {pendingDecision === 'reject' && <Spinner />}
                Refuser
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
