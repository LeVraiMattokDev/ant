import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ApprovalDTO } from '@ant/shared';
import { useAllApprovals, useBotMap, usePendingApprovals } from '../lib/queries';
import { ApprovalCard } from '../components/approvals/ApprovalCard';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader, Tabs } from '../components/ui';

type Tab = 'pending' | 'history';

export function ApprovalsPage() {
  const [params] = useSearchParams();
  const focusId = params.get('id');
  const pending = usePendingApprovals();
  const all = useAllApprovals();
  const bots = useBotMap();
  const [tab, setTab] = useState<Tab>('pending');
  const [highlight, setHighlight] = useState<string | null>(null);

  // Deep link from a push notification: pick the right tab, then scroll to the card.
  useEffect(() => {
    if (!focusId) return;
    const inPending = pending.data?.some((a) => a.id === focusId);
    const inAll = all.data?.some((a) => a.id === focusId);
    if (inPending) setTab('pending');
    else if (inAll) setTab('history');
    else return;
    setHighlight(focusId);
    requestAnimationFrame(() => document.getElementById(`approval-${focusId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [focusId, pending.data, all.data]);

  const pendingList = [...(pending.data ?? [])].sort(
    (a, b) => Number(b.urgent) - Number(a.urgent) || a.expiresAt.localeCompare(b.expiresAt),
  );
  const history: ApprovalDTO[] = (all.data ?? [])
    .filter((a) => a.status !== 'pending')
    .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));

  const query = tab === 'pending' ? pending : all;
  const list = tab === 'pending' ? pendingList : history;

  return (
    <>
      <PageHeader title="Validations" description="Les actions sensibles des bots attendent ton accord. Rien n’est exécuté sans lui." />
      <div className="px-4 md:px-8">
        <Tabs<Tab>
          label="Validations"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'pending', label: `En attente${pendingList.length ? ` (${pendingList.length})` : ''}` },
            { id: 'history', label: 'Historique' },
          ]}
        />
      </div>
      <div className="scroll-y flex-1 px-4 pt-4 pb-8 md:px-8">
        <div className="max-w-3xl">
          {query.isPending ? (
            <LoadingBlock />
          ) : query.isError && !query.data ? (
            <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />
          ) : list.length === 0 ? (
            <EmptyState title={tab === 'pending' ? 'Rien à valider' : 'Aucune validation passée'}>
              {tab === 'pending'
                ? 'Quand un bot voudra envoyer un message en ton nom, publier, acheter ou supprimer quelque chose, la demande apparaîtra ici.'
                : 'Les décisions prises apparaîtront ici avec leur résultat.'}
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {list.map((a) => (
                <li key={a.id}>
                  <ApprovalCard approval={a} bot={bots.get(a.botId)} highlighted={highlight === a.id} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
