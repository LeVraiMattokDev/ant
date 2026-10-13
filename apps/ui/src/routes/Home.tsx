import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MODEL_LABELS, type NudgeDTO } from '@ant/shared';
import { patch } from '../lib/api';
import { COMPUTE_SOURCE_LABELS, HEALTH_LABELS, NUDGE_KIND_LABELS, RUN_STATUS_LABELS } from '../lib/labels';
import { formatDuration, formatPercent, formatRelative, formatShort, formatUsd } from '../lib/format';
import { useNow } from '../lib/hooks';
import { qk, useActiveRuns, useBotMap, useBots, useChannels, useNudges, usePendingApprovals, useQuota } from '../lib/queries';
import { toast } from '../lib/toast';
import { Markdown } from '../components/Markdown';
import { useCancelRun } from '../components/chat/ActivityBar';
import { Badge, EmptyState, Gauge, PageHeader, Spinner, cx } from '../components/ui';
import { BotStatus } from './Bots';
import { BotAvatar } from '../components/BotAvatar';
import { FeatureHomeCards } from '../features';

function Card({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx('card', className)}>
      <header className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, to, tone }: { label: string; value: React.ReactNode; to?: string; tone?: 'accent' | 'danger' }) {
  const body = (
    <>
      <div className="text-[12px] text-muted">{label}</div>
      <div className={cx('mt-1 text-[22px] font-semibold tracking-[-0.02em]', tone === 'accent' && 'text-accent-text', tone === 'danger' && 'text-danger')}>
        {value}
      </div>
    </>
  );
  return to ? (
    <Link to={to} className="card block px-3.5 py-3 hover:border-line-strong">
      {body}
    </Link>
  ) : (
    <div className="card px-3.5 py-3">{body}</div>
  );
}

function NudgeItem({ nudge }: { nudge: NudgeDTO }) {
  const bots = useBotMap();
  const qc = useQueryClient();
  const bot = bots.get(nudge.botId);
  const update = useMutation({
    mutationFn: (status: 'acted' | 'dismissed') => patch<NudgeDTO>(`/api/nudges/${nudge.id}`, { status }),
    onSuccess: (n) => {
      qc.setQueriesData<NudgeDTO[]>({ queryKey: qk.nudgesAll }, (d) => d?.map((x) => (x.id === n.id ? n : x)));
    },
    onError: (err) => toast.fromError(err),
  });
  const open = nudge.status === 'delivered' || nudge.status === 'deferred';
  return (
    <li className={cx('px-3.5 py-3', !open && 'opacity-60')}>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <BotAvatar bot={bot} size={20} />
        <span className="font-medium text-fg">{bot?.name ?? 'Bot'}</span>
        <Badge tone="accent">{NUDGE_KIND_LABELS[nudge.kind] ?? nudge.kind}</Badge>
        <span className="ml-auto text-subtle">{formatShort(nudge.createdAt)}</span>
      </div>
      <div className="mt-1.5 text-[14px] font-semibold">{nudge.title}</div>
      <Markdown source={nudge.content} className="mt-0.5 line-clamp-4 text-[13px] text-muted" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {open ? (
          <>
            <button type="button" className="btn btn-sm" onClick={() => update.mutate('acted')} disabled={update.isPending}>
              Utile
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => update.mutate('dismissed')} disabled={update.isPending}>
              Ignorer
            </button>
          </>
        ) : (
          <span className="text-[12px] text-subtle">{nudge.status === 'acted' ? 'Marquée utile' : 'Ignorée'}</span>
        )}
        {nudge.messageId && bot && (
          <Link to={`/c/${bot.dmChannelId}?m=${nudge.messageId}`} className="ml-auto text-[12.5px] text-accent-text hover:underline">
            Voir le message
          </Link>
        )}
      </div>
    </li>
  );
}

function QuotaCard() {
  const quota = useQuota();
  const q = quota.data;
  return (
    <Card title="Quota et budget" action={<Link to="/quota" className="text-[12.5px] text-accent-text hover:underline">Détails</Link>}>
      {!q ? (
        <div className="p-3.5">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-3 px-3.5 py-3 text-[13px]">
          <div className="flex items-center justify-between">
            <span className="text-muted">Abonnement</span>
            <Badge tone={q.subscription.health === 'ok' ? 'success' : q.subscription.health === 'warning' ? 'warning' : q.subscription.health === 'limited' || q.subscription.health === 'auth_failed' ? 'danger' : 'neutral'}>
              {HEALTH_LABELS[q.subscription.health]}
            </Badge>
          </div>
          <div>
            <div className="mb-1 flex justify-between text-[12px] text-muted">
              <span>Fenêtre 5 h</span>
              <span>{formatPercent(q.subscription.fiveHour.utilization)}</span>
            </div>
            <Gauge
              label="Utilisation sur 5 heures"
              value={q.subscription.fiveHour.utilization}
              marks={[
                { at: q.thresholds.reserveFiveHour, label: 'réserve' },
                { at: q.thresholds.hardFiveHour, label: 'maximum' },
              ]}
            />
          </div>
          <div>
            <div className="mb-1 flex justify-between text-[12px] text-muted">
              <span>Semaine</span>
              <span>{formatPercent(q.subscription.sevenDay.utilization)}</span>
            </div>
            <Gauge
              label="Utilisation hebdomadaire"
              value={q.subscription.sevenDay.utilization}
              marks={[
                { at: q.thresholds.reserveWeekly, label: 'réserve' },
                { at: q.thresholds.hardWeekly, label: 'maximum' },
              ]}
            />
          </div>
          <div className="flex justify-between border-t border-line pt-2">
            <span className="text-muted">Crédits API aujourd’hui</span>
            <span>
              {formatUsd(q.api.spentTodayUsd)} <span className="text-subtle">/ {formatUsd(q.api.dailyCapUsd)}</span>
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

export function HomePage() {
  const pending = usePendingApprovals();
  const runs = useActiveRuns();
  const nudges = useNudges(undefined, 10);
  const bots = useBots();
  const botMap = useBotMap();
  const channels = useChannels();
  const quota = useQuota();
  const cancel = useCancelRun();
  useNow(15_000);

  const channelLabel = (id: string | null) => {
    const c = channels.data?.find((x) => x.id === id);
    if (!c) return null;
    return c.kind === 'group' ? `#${c.name}` : 'conversation privée';
  };

  const pendingCount = pending.data?.length ?? 0;
  const urgent = pending.data?.filter((a) => a.urgent).length ?? 0;

  return (
    <>
      <PageHeader title="Accueil" description="Ce qui demande ton attention, et ce que font tes bots en ce moment." />
      <div className="scroll-y flex-1 px-4 pb-8 md:px-8">
        <div className="max-w-6xl space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={urgent ? `Validations (dont ${urgent} urgente${urgent > 1 ? 's' : ''})` : 'Validations en attente'} value={pending.isPending ? '—' : pendingCount} to="/approvals" tone={pendingCount ? 'accent' : undefined} />
            <Stat label="Exécutions en cours" value={runs.data?.length ?? '—'} />
            <Stat
              label="Crédits API ce mois"
              value={quota.data ? formatUsd(quota.data.api.spentMonthUsd) : '—'}
              to="/quota"
              tone={quota.data && quota.data.api.spentMonthUsd >= quota.data.api.monthlyCapUsd ? 'danger' : undefined}
            />
            <Stat
              label="Bots actifs"
              value={bots.data ? `${bots.data.filter((b) => !b.paused).length}/${bots.data.length}` : '—'}
              to="/bots"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              <Card title="Exécutions en cours">
                {!runs.data ? (
                  <div className="p-3.5">
                    <Spinner />
                  </div>
                ) : runs.data.length === 0 ? (
                  <p className="px-3.5 py-3 text-[13px] text-subtle">Aucun bot ne travaille en ce moment.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {runs.data.map((r) => {
                      const bot = botMap.get(r.botId);
                      const where = channelLabel(r.channelId);
                      return (
                        <li key={r.id} className="flex items-center gap-3 px-3.5 py-2.5">
                          <BotAvatar bot={bot} size={32} />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
                              <span className="font-medium">{bot?.name ?? 'Bot'}</span>
                              <span className="text-muted">{r.activity ?? RUN_STATUS_LABELS[r.status]}</span>
                            </div>
                            <div className="flex flex-wrap gap-x-2 text-[12px] text-subtle">
                              <span>{MODEL_LABELS[r.model] ?? r.model}</span>
                              {r.computeSource && <span>{COMPUTE_SOURCE_LABELS[r.computeSource]}</span>}
                              <span>{formatDuration(r.startedAt ?? r.createdAt, null)}</span>
                              {where && r.channelId && (
                                <Link className="hover:text-fg hover:underline" to={r.threadRootId ? `/c/${r.channelId}/t/${r.threadRootId}` : `/c/${r.channelId}`}>
                                  {where}
                                </Link>
                              )}
                            </div>
                          </div>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => cancel.mutate(r.id)} disabled={cancel.isPending}>
                            Annuler
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card title="Relances récentes">
                {nudges.isPending ? (
                  <div className="p-3.5">
                    <Spinner />
                  </div>
                ) : !nudges.data?.length ? (
                  <EmptyState title="Pas encore de relance">
                    Pendant leurs heartbeats, les bots te proposent des idées, signalent des risques ou des oublis. Elles apparaîtront ici.
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-line">
                    {nudges.data.map((n) => (
                      <NudgeItem key={n.id} nudge={n} />
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <div className="space-y-4">
              {pendingCount > 0 && (
                <Card title="À valider" action={<Link to="/approvals" className="text-[12.5px] text-accent-text hover:underline">Tout voir</Link>}>
                  <ul className="divide-y divide-line">
                    {pending.data!.slice(0, 5).map((a) => (
                      <li key={a.id}>
                        <Link to={`/approvals?id=${a.id}`} className="block px-3.5 py-2.5 hover:bg-hover">
                          <div className="flex items-center gap-2 text-[13.5px] font-medium">
                            {a.urgent && <Badge tone="danger">Urgent</Badge>}
                            <span className="truncate">{a.title}</span>
                          </div>
                          <div className="text-[12px] text-subtle">
                            {botMap.get(a.botId)?.name ?? 'Bot'} · expire {formatRelative(a.expiresAt)}
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              <FeatureHomeCards />
              <QuotaCard />
              <Card title="Bots" action={<Link to="/bots" className="text-[12.5px] text-accent-text hover:underline">Gérer</Link>}>
                {!bots.data ? (
                  <div className="p-3.5">
                    <Spinner />
                  </div>
                ) : bots.data.length === 0 ? (
                  <EmptyState title="Aucun bot" action={<Link to="/bots/new" className="btn btn-primary btn-sm">Créer un bot</Link>} />
                ) : (
                  <ul className="divide-y divide-line">
                    {bots.data.map((b) => (
                      <li key={b.id}>
                        <Link to={`/c/${b.dmChannelId}`} className="flex items-center gap-2.5 px-3.5 py-2 hover:bg-hover">
                          <BotAvatar bot={b} size={26} />
                          <span className="text-[13.5px] font-medium">{b.name}</span>
                          <span className="ml-auto max-w-[55%] truncate">
                            <BotStatus bot={b} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
