import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRightLeft, CalendarClock, GitBranch, Info, Repeat, Wrench, ShieldCheck } from 'lucide-react';
import { EFFORT_LABELS, MODEL_LABELS, isEffortLevel, type BotDTO, type MessageDTO } from '@ant/shared';
import { formatFull, formatShort } from '../../lib/format';
import { useAllApprovals } from '../../lib/queries';
import { Markdown } from '../Markdown';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { cx } from '../ui';

const SYSTEM_KINDS = new Set(['delegation', 'handoff', 'compute_switch', 'approval', 'tool', 'info', 'error']);

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
}: {
  icon: ReactNode;
  tone?: 'muted' | 'accent' | 'danger' | 'info';
  title: ReactNode;
  time: string;
  children?: ReactNode;
}) {
  const toneClass = {
    muted: 'border-line bg-surface',
    accent: 'border-accent/40 bg-accent-soft',
    danger: 'border-danger/40 bg-danger-soft',
    info: 'border-info/30 bg-info-soft',
  }[tone];
  return (
    <div className={cx('rounded-[6px] border px-3 py-2', toneClass)}>
      <div className="flex items-start gap-2 text-[13px]">
        <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
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

function botLabel(bots: Map<string, BotDTO>, id: string | null | undefined): string {
  if (!id) return 'un bot';
  const b = bots.get(id);
  return b ? `${b.avatar} ${b.name}` : 'un bot';
}

function InlineApproval({ approvalId, bots }: { approvalId: string; bots: Map<string, BotDTO> }) {
  const { data, isPending } = useAllApprovals();
  const approval = data?.find((a) => a.id === approvalId);
  if (isPending) return <div className="mt-2 text-[12.5px] text-subtle">Chargement de la validation…</div>;
  if (!approval) return <div className="mt-2 text-[12.5px] text-subtle">Validation introuvable (peut-être supprimée).</div>;
  return (
    <div className="mt-2 max-w-xl">
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
                  <span className="chip">{MODEL_LABELS[sub.model] ?? sub.model}</span>
                  {effort && <span className="chip">effort {effort}</span>}
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
            meta.handoff
              ? `Transfert : ${botLabel(bots, meta.handoff.fromBotId)} → ${botLabel(bots, meta.handoff.toBotId)}`
              : 'Transfert entre bots'
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
    case 'approval':
      return (
        <Row icon={<ShieldCheck className="size-4" />} tone="accent" time={createdAt} title={`Validation demandée${author ? ` par ${author.name}` : ''}`}>
          {body}
          {meta.approvalId && <InlineApproval approvalId={meta.approvalId} bots={bots} />}
        </Row>
      );
    case 'routine':
      return (
        <Row icon={<CalendarClock className="size-4" />} time={createdAt} title="Routine">
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
