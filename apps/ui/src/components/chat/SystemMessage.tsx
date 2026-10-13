import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRightLeft, BellRing, CalendarClock, GitBranch, Info, PenLine, Repeat, Wrench, ShieldCheck } from 'lucide-react';
import { EFFORT_LABELS, MODEL_LABELS, isEffortLevel, type BotDTO, type MessageDTO } from '@ant/shared';
import { formatFull, formatShort } from '../../lib/format';
import { useAllApprovals, useApproval } from '../../lib/queries';
import { Markdown } from '../Markdown';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { BotAvatar } from '../BotAvatar';
import { cx } from '../ui';

const SYSTEM_KINDS = new Set(['delegation', 'handoff', 'compute_switch', 'approval', 'tool', 'info', 'error', 'reminder', 'draft']);

/** System-authored messages, and bot messages whose kind is an event rather than a reply. */
export function isSystemStyled(m: MessageDTO): boolean {
  if (m.authorKind === 'system') return true;
  return m.authorKind === 'bot' && !!m.meta.kind && SYSTEM_KINDS.has(m.meta.kind);
}

function Row({
  icon,
  tone = 'muted',
  title,
  time,
  children,
  wide = false,
}: {
  icon: ReactNode;
  tone?: 'muted' | 'accent' | 'danger' | 'info' | 'plain';
  title: ReactNode;
  time: string;
  children?: ReactNode;
  /** Approval cards need room. */
  wide?: boolean;
}) {
  const toneClass = {
    muted: 'border-line bg-surface',
    accent: 'border-accent/35 bg-accent-soft',
    danger: 'border-danger/40 bg-danger-soft',
    info: 'border-info/30 bg-info-soft',
    plain: 'border-transparent !px-1',
  }[tone];
  const iconTone = { muted: 'text-subtle', accent: 'text-accent-text', danger: 'text-danger', info: 'text-info', plain: 'text-accent-text' }[tone];
  return (
    <div className={cx('w-full rounded-[16px] border px-3.5 py-2.5', wide ? 'max-w-[640px]' : 'max-w-[600px] sm:w-fit sm:min-w-[340px]', toneClass)}>
      <div className="flex items-start gap-2.5 text-[13px]">
        <span className={cx('mt-[1px] shrink-0', iconTone)}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-medium">{title}</span>
            <time dateTime={time} title={formatFull(time)} className="text-[11.5px] text-subtle">
              {formatShort(time)}
            </time>
          </div>
          {children && <div className="mt-1 text-muted">{children}</div>}
        </div>
      </div>
    </div>
  );
}

function BotName({ bots, id }: { bots: Map<string, BotDTO>; id: string | null | undefined }) {
  const b = id ? bots.get(id) : undefined;
  if (!b) return <>un bot</>;
  return (
    <span className="inline-flex items-center gap-1 align-[-3px]">
      <BotAvatar bot={b} size={16} />
      {b.name}
    </span>
  );
}

function InlineApproval({ approvalId, bots }: { approvalId: string; bots: Map<string, BotDTO> }) {
  const list = useAllApprovals();
  const fromList = list.data?.find((a) => a.id === approvalId);
  // The list only holds the most recent approvals: an older one is fetched on its own.
  const single = useApproval(approvalId, !!list.data && !fromList);
  const approval = fromList ?? single.data;
  if (list.isPending || (!approval && single.isPending && single.fetchStatus !== 'idle')) {
    return <div className="mt-2 text-[12.5px] text-subtle">Chargement de la validation…</div>;
  }
  if (!approval) return <div className="mt-2 text-[12.5px] text-subtle">Validation introuvable (peut-être supprimée).</div>;
  return (
    <div className="mt-2">
      <ApprovalCard approval={approval} bot={bots.get(approval.botId)} compact />
    </div>
  );
}

export function SystemMessage({ message, bots }: { message: MessageDTO; bots: Map<string, BotDTO> }) {
  const { meta, content, createdAt } = message;
  const author = message.botId ? bots.get(message.botId) : undefined;
  const body = content ? <Markdown source={content} className="text-[13px] text-fg" /> : null;

  switch (meta.kind) {
    case 'delegation': {
      const sub = meta.subagent;
      const tier = sub?.tier === 'expert' ? 'expert' : sub?.tier === 'leger' ? 'léger' : 'spécialisé';
      const effort = sub?.effort ? (isEffortLevel(sub.effort) ? EFFORT_LABELS[sub.effort] : sub.effort) : null;
      return (
        <Row
          icon={<GitBranch className="size-4" />}
          tone="info"
          time={createdAt}
          title={
            <>
              {author ? `${author.name} délègue` : 'Délégation'} à un sous-agent {tier}
              {sub && (
                <span className="ml-1.5 inline-flex gap-1 align-middle">
                  <span className="chip bg-info/15 !text-fg">{MODEL_LABELS[sub.model] ?? sub.model}</span>
                  {effort && <span className="chip bg-info/15 !text-fg">effort {effort}</span>}
                </span>
              )}
            </>
          }
        >
          {sub?.reason && (
            <div className="text-[13px]">
              <span className="text-subtle">Raison : </span>
              <span className="text-fg">{sub.reason}</span>
            </div>
          )}
          {body}
        </Row>
      );
    }
    case 'handoff':
      return (
        <Row
          icon={<ArrowRightLeft className="size-4" />}
          tone="accent"
          time={createdAt}
          title={
            meta.handoff ? (
              <>
                Transfert : <BotName bots={bots} id={meta.handoff.fromBotId} /> → <BotName bots={bots} id={meta.handoff.toBotId} />
              </>
            ) : (
              'Transfert entre bots'
            )
          }
        >
          {body}
        </Row>
      );
    case 'compute_switch':
      return (
        <Row icon={<Repeat className="size-4" />} time={createdAt} title="Changement de source de calcul">
          {body}
        </Row>
      );
    case 'approval': {
      // Only the request (posted by the bot's run) carries runId/botId. Outcome notices (refused, executed, failed,
      // expired) reference the same approval: they show their text only, the card is already under the request.
      const isRequest = !!meta.runId || !!message.botId;
      if (!isRequest) {
        return (
          <Row icon={<ShieldCheck className="size-4" />} time={createdAt} title="Validation">
            {body}
          </Row>
        );
      }
      return (
        <Row icon={<ShieldCheck className="size-4" />} tone="plain" wide time={createdAt} title={`Validation demandée${author ? ` par ${author.name}` : ''}`}>
          {body}
          {meta.approvalId && <InlineApproval approvalId={meta.approvalId} bots={bots} />}
        </Row>
      );
    }
    case 'routine':
      return (
        <Row icon={<CalendarClock className="size-4" />} time={createdAt} title="Routine">
          {body}
        </Row>
      );
    case 'reminder':
      return (
        <Row icon={<BellRing className="size-4" />} tone="accent" time={createdAt} title={author ? `Rappel de ${author.name}` : 'Rappel'}>
          {body}
        </Row>
      );
    case 'draft':
      // The draft card itself is a feature extra rendered under this row (meta.draftId).
      return (
        <Row icon={<PenLine className="size-4" />} tone="plain" wide time={createdAt} title={author ? `Brouillon X de ${author.name}` : 'Brouillon X'}>
          {body}
        </Row>
      );
    case 'tool':
      return (
        <Row icon={<Wrench className="size-4" />} time={createdAt} title={meta.tool ? `Outil ${meta.tool.name}` : 'Outil'}>
          {meta.tool?.summary && <div className="text-[13px]">{meta.tool.summary}</div>}
          {body}
        </Row>
      );
    case 'error':
      return (
        <Row icon={<AlertTriangle className="size-4 text-danger" />} tone="danger" time={createdAt} title="Erreur">
          {body}
        </Row>
      );
    default:
      return (
        <Row icon={<Info className="size-4" />} time={createdAt} title={author ? author.name : 'Information'}>
          {body}
        </Row>
      );
  }
}
