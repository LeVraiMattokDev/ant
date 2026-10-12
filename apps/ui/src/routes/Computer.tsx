import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Hand, RotateCcw } from 'lucide-react';
import type { ComputerHolder, ComputerStatusDTO } from '@ant/shared';
import { post } from '../lib/api';
import { formatFull, formatRelative, formatShort } from '../lib/format';
import { useBotMap, useComputerActivity, useComputerStatus, qk } from '../lib/queries';
import { toast } from '../lib/toast';
import { VncScreen } from '../components/computer/VncScreen';
import { TerminalView } from '../components/computer/TerminalView';
import { FilesBrowser } from '../components/computer/FilesBrowser';
import { Avatar, Badge, EmptyState, ErrorBlock, LoadingBlock, PageHeader, Spinner, Tabs } from '../components/ui';

type Tab = 'screen' | 'terminal' | 'activity' | 'files';

function Offline() {
  return (
    <div role="alert" className="card mx-auto max-w-xl p-5">
      <h2 className="text-[15px] font-semibold">Ordinateur des agents injoignable</h2>
      <p className="mt-1.5 text-[13.5px] text-muted">
        Le service <span className="mono">computer</span> ne répond pas. Les bots ne peuvent pas utiliser le terminal, le navigateur ni les fichiers tant qu’il
        est arrêté. Vérifie le conteneur avec <span className="mono">docker compose ps computer</span> et ses journaux.
      </p>
    </div>
  );
}

function ActivityList() {
  const activity = useComputerActivity(true);
  const bots = useBotMap();
  if (activity.isPending) return <LoadingBlock />;
  if (activity.isError) return <ErrorBlock error={activity.error} onRetry={() => void activity.refetch()} />;
  if (!activity.data.length) return <EmptyState title="Aucune action récente">Les actions des bots sur l’ordinateur s’afficheront ici.</EmptyState>;
  return (
    <ul className="card divide-y divide-line">
      {activity.data.map((a) => {
        const slug = a.actor.startsWith('bot:') ? a.actor.slice(4) : null;
        const bot = slug ? [...bots.values()].find((b) => b.slug === slug || b.id === slug) : undefined;
        const detail = a.detail && typeof a.detail === 'object' ? (a.detail as Record<string, unknown>) : null;
        const summary =
          (detail && (typeof detail.summary === 'string' ? detail.summary : typeof detail.command === 'string' ? detail.command : typeof detail.url === 'string' ? detail.url : null)) ??
          null;
        return (
          <li key={a.id} className="flex gap-3 px-3 py-2">
            <Avatar emoji={bot?.avatar ?? '·'} size="sm" />
            <div className="min-w-0 flex-1 text-[13px]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{bot?.name ?? a.actor}</span>
                <span className="mono text-muted">{a.tool ?? a.event}</span>
                {a.outcome && <span className="text-[12px] text-subtle">{a.outcome}</span>}
                <time className="ml-auto text-[11.5px] text-subtle" title={formatFull(a.at)}>
                  {formatShort(a.at)}
                </time>
              </div>
              {summary && <div className="mono mt-0.5 truncate text-[12px] text-muted">{summary}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function StatusBar({ status }: { status: ComputerStatusDTO }) {
  const bots = useBotMap();
  const active = status.activeBotId ? bots.get(status.activeBotId) : undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px]">
      <Badge tone={status.online ? 'success' : 'danger'}>{status.online ? 'En ligne' : 'Hors ligne'}</Badge>
      <span>
        <span className="text-subtle">Contrôle : </span>
        <span className="font-medium">{status.holder === 'user' ? 'toi' : 'les agents'}</span>
        <span className="text-subtle" title={formatFull(status.since)}>
          {' '}
          depuis {formatRelative(status.since).replace(/^il y a /, '')}
        </span>
      </span>
      {active && (
        <span className="flex items-center gap-1">
          <span className="text-subtle">Bot actif :</span>
          <Avatar emoji={active.avatar} size="sm" />
          {active.name}
        </span>
      )}
      {status.lastAction && (
        <span className="min-w-0 truncate">
          <span className="text-subtle">Dernière action : </span>
          {status.lastAction}
        </span>
      )}
      {status.url && (
        <span className="mono min-w-0 max-w-full truncate text-muted" title={status.url}>
          {status.url}
        </span>
      )}
    </div>
  );
}

export default function ComputerPage() {
  const status = useComputerStatus();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('screen');

  const control = useMutation({
    mutationFn: (holder: ComputerHolder) => post<ComputerStatusDTO>('/api/computer/control', { holder }),
    onSuccess: (s) => {
      qc.setQueryData(qk.computerStatus, s);
      toast.info(s.holder === 'user' ? 'Tu as la main' : 'Les agents ont repris la main');
    },
    onError: (err) => toast.fromError(err, 'Changement de contrôle impossible'),
  });

  const s = status.data;
  const online = !!s?.online && !status.isError;
  const userHolds = s?.holder === 'user';

  return (
    <>
      <PageHeader
        title="Ordinateur"
        description="La machine isolée sur laquelle les bots naviguent, exécutent des commandes et manipulent des fichiers."
        actions={
          s &&
          online && (
            <button
              type="button"
              className={userHolds ? 'btn' : 'btn btn-primary'}
              disabled={control.isPending}
              onClick={() => control.mutate(userHolds ? 'agents' : 'user')}
            >
              {control.isPending ? <Spinner /> : userHolds ? <RotateCcw className="size-4" /> : <Hand className="size-4" />}
              {userHolds ? 'Rendre la main aux agents' : 'Prendre la main'}
            </button>
          )
        }
      />
      <div className="border-b border-line px-4 py-2 md:px-6">{s ? <StatusBar status={s} /> : status.isPending ? <Spinner /> : null}</div>
      <div className="px-4 md:px-6">
        <Tabs<Tab>
          label="Ordinateur"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'screen', label: 'Écran' },
            { id: 'terminal', label: 'Terminal' },
            { id: 'activity', label: 'Activité' },
            { id: 'files', label: 'Fichiers' },
          ]}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-4 md:p-6">
        {status.isPending ? (
          <LoadingBlock />
        ) : tab === 'activity' ? (
          <div className="scroll-y flex-1">
            <ActivityList />
          </div>
        ) : !online ? (
          <Offline />
        ) : tab === 'screen' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {userHolds && (
              <p className="mb-2 text-[12.5px] text-warning">Tant que tu as la main, les bots n’utilisent plus l’ordinateur : ils s’arrêtent et expliquent où ils en sont.</p>
            )}
            <div className="min-h-0 flex-1">
              <VncScreen interactive={userHolds} />
            </div>
          </div>
        ) : tab === 'terminal' ? (
          <div className="min-h-0 flex-1">
            <TerminalView interactive={userHolds} />
          </div>
        ) : (
          <div className="scroll-y flex-1">
            <FilesBrowser />
          </div>
        )}
      </div>
    </>
  );
}
