import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import type { AuditEntryDTO } from '@ant/shared';
import { formatFull, formatShort } from '../lib/format';
import { useDebouncedValue } from '../lib/hooks';
import { useAudit } from '../lib/queries';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader, Spinner, cx } from '../components/ui';

function outcomeTone(outcome: string | null): string {
  if (!outcome) return 'text-subtle';
  if (/(error|fail|denied|refus|reject|échec)/i.test(outcome)) return 'text-danger';
  if (/(ok|success|approved|executed|done)/i.test(outcome)) return 'text-success';
  return 'text-muted';
}

function DetailRow({ entry }: { entry: AuditEntryDTO }) {
  return (
    <tr className="bg-bg">
      <td colSpan={6} className="px-4 py-3">
        <dl className="grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-[120px_1fr]">
          <dt className="text-subtle">Identifiant</dt>
          <dd className="mono">{entry.id}</dd>
          <dt className="text-subtle">Date</dt>
          <dd>{formatFull(entry.at)}</dd>
          {entry.runId && (
            <>
              <dt className="text-subtle">Exécution</dt>
              <dd className="mono break-all">{entry.runId}</dd>
            </>
          )}
          {entry.ip && (
            <>
              <dt className="text-subtle">Adresse IP</dt>
              <dd className="mono">{entry.ip}</dd>
            </>
          )}
        </dl>
        <pre className="mono mt-2 max-h-96 overflow-auto rounded-[4px] border border-line bg-surface p-2.5 text-[12px] whitespace-pre-wrap">
          {JSON.stringify(entry.detail, null, 2) ?? 'null'}
        </pre>
      </td>
    </tr>
  );
}

export function AuditPage() {
  const [event, setEvent] = useState('');
  const [actor, setActor] = useState('');
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const filters = { event: useDebouncedValue(event.trim(), 350) || undefined, actor: useDebouncedValue(actor.trim(), 350) || undefined };
  const audit = useAudit(filters);
  const rows = audit.data?.pages.flat() ?? [];

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <PageHeader
        title="Journal d’audit"
        description="Chaque exécution, appel d’outil, validation, bascule de calcul et connexion. Le journal ne peut pas être modifié."
        actions={
          <div className="flex items-center gap-2">
            <select className="select w-32" aria-label="Période de l’export" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7 jours</option>
              <option value={30}>30 jours</option>
              <option value={90}>90 jours</option>
              <option value={365}>1 an</option>
            </select>
            <a className="btn" href={`/api/audit/export.csv?days=${days}`} download>
              <Download className="size-4" />
              Exporter en CSV
            </a>
          </div>
        }
      />
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2.5 md:px-6">
        <input className="input w-full sm:w-56" placeholder="Événement (ex. tool.call)" aria-label="Filtrer par événement" value={event} onChange={(e) => setEvent(e.target.value)} />
        <input className="input w-full sm:w-56" placeholder="Acteur (ex. bot:dev, owner)" aria-label="Filtrer par acteur" value={actor} onChange={(e) => setActor(e.target.value)} />
      </div>
      <div className="scroll-y flex-1">
        {audit.isPending ? (
          <LoadingBlock />
        ) : audit.isError ? (
          <ErrorBlock error={audit.error} onRetry={() => void audit.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="Aucune entrée">{filters.event || filters.actor ? 'Aucune entrée ne correspond à ces filtres.' : 'Le journal est vide.'}</EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[13px]">
                <thead className="sticky top-0 z-[1] bg-bg text-left text-[12px] text-subtle">
                  <tr className="border-b border-line">
                    <th className="w-8" />
                    <th className="px-2 py-2 font-medium">Date</th>
                    <th className="px-2 py-2 font-medium">Acteur</th>
                    <th className="px-2 py-2 font-medium">Événement</th>
                    <th className="px-2 py-2 font-medium">Outil</th>
                    <th className="px-4 py-2 font-medium">Résultat</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const expanded = open.has(r.id);
                    return (
                      <Fragment key={r.id}>
                        <tr
                          className={cx('cursor-pointer border-b border-line hover:bg-surface', expanded && 'bg-surface')}
                          onClick={() => toggle(r.id)}
                        >
                          <td className="pl-3">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm btn-icon"
                              aria-expanded={expanded}
                              aria-label={expanded ? 'Masquer le détail' : 'Afficher le détail'}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(r.id);
                              }}
                            >
                              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                            </button>
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap" title={formatFull(r.at)}>
                            {formatShort(r.at)}
                          </td>
                          <td className="mono px-2 py-1.5 whitespace-nowrap">{r.actor}</td>
                          <td className="mono px-2 py-1.5">{r.event}</td>
                          <td className="mono px-2 py-1.5 text-muted">{r.tool ?? '—'}</td>
                          <td className={cx('px-4 py-1.5', outcomeTone(r.outcome))}>{r.outcome ?? '—'}</td>
                        </tr>
                        {expanded && <DetailRow entry={r} />}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex justify-center py-4">
              {audit.hasNextPage ? (
                <button type="button" className="btn" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
                  {audit.isFetchingNextPage && <Spinner />}
                  Charger les entrées plus anciennes
                </button>
              ) : (
                <span className="text-[12px] text-subtle">Fin du journal</span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
