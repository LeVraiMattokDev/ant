import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MODEL_LABELS, type BotDTO, type TaskDTO } from '@ant/shared';
import { patch } from '../../lib/api';
import { qk, useNudges, useRuns, useTasks } from '../../lib/queries';
import {
  COMPUTE_SOURCE_LABELS,
  NUDGE_KIND_LABELS,
  RUN_STATUS_LABELS,
  RUN_TRIGGER_LABELS,
  TASK_STATUS_LABELS,
} from '../../lib/labels';
import { formatDuration, formatFull, formatShort, formatUsd } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, ErrorBlock, Spinner } from '../ui';

function Panel({ title, children, count }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="flex items-center justify-between border-b border-line px-3 py-2 text-[13px] font-semibold">
        {title}
        {count !== undefined && <span className="text-[12px] font-normal text-subtle">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

export function TasksPanel({ bot }: { bot: BotDTO }) {
  const tasks = useTasks(bot.id);
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TaskDTO['status'] }) => patch<TaskDTO>(`/api/tasks/${id}`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.tasksAll }),
    onError: (err) => toast.fromError(err, 'Tâche non modifiée'),
  });
  return (
    <Panel title="Tâches ouvertes" count={tasks.data?.length}>
      {tasks.isPending ? (
        <div className="p-3">
          <Spinner />
        </div>
      ) : tasks.isError ? (
        <ErrorBlock error={tasks.error} />
      ) : tasks.data.length === 0 ? (
        <p className="px-3 py-3 text-[13px] text-subtle">Aucune tâche en cours.</p>
      ) : (
        <ul className="divide-y divide-line">
          {tasks.data.map((t) => (
            <li key={t.id} className="px-3 py-2">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">{t.title}</div>
                  {t.details && <p className="mt-0.5 line-clamp-3 text-[12.5px] text-muted">{t.details}</p>}
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[11.5px] text-subtle">
                    <Badge tone={t.status === 'waiting' ? 'warning' : 'neutral'}>{TASK_STATUS_LABELS[t.status]}</Badge>
                    {t.dueAt && <span title={formatFull(t.dueAt)}>échéance {formatShort(t.dueAt)}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ id: t.id, status: 'done' })}
                  >
                    Terminée
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ id: t.id, status: 'dropped' })}
                  >
                    Abandonner
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function NudgesPanel({ bot }: { bot: BotDTO }) {
  const nudges = useNudges(bot.id, 10);
  return (
    <Panel title="Relances récentes">
      {nudges.isPending ? (
        <div className="p-3">
          <Spinner />
        </div>
      ) : nudges.isError ? (
        <ErrorBlock error={nudges.error} />
      ) : nudges.data.length === 0 ? (
        <p className="px-3 py-3 text-[13px] text-subtle">Aucune relance pour l’instant.</p>
      ) : (
        <ul className="divide-y divide-line">
          {nudges.data.map((n) => (
            <li key={n.id} className="px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11.5px] text-subtle">
                <Badge tone="accent">{NUDGE_KIND_LABELS[n.kind] ?? n.kind}</Badge>
                <span>{formatShort(n.createdAt)}</span>
                {n.status === 'acted' && <span>· utile</span>}
                {n.status === 'dismissed' && <span>· ignorée</span>}
              </div>
              {n.messageId ? (
                <Link to={`/c/${bot.dmChannelId}?m=${n.messageId}`} className="mt-1 block text-[13.5px] font-medium hover:underline">
                  {n.title}
                </Link>
              ) : (
                <div className="mt-1 text-[13.5px] font-medium">{n.title}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function RunsPanel({ bot }: { bot: BotDTO }) {
  const runs = useRuns(bot.id, 15);
  return (
    <Panel title="Exécutions récentes">
      {runs.isPending ? (
        <div className="p-3">
          <Spinner />
        </div>
      ) : runs.isError ? (
        <ErrorBlock error={runs.error} />
      ) : runs.data.length === 0 ? (
        <p className="px-3 py-3 text-[13px] text-subtle">Aucune exécution.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-subtle">
              <tr className="border-b border-line">
                <th className="px-3 py-1.5 font-medium">Début</th>
                <th className="px-2 py-1.5 font-medium">Statut</th>
                <th className="px-2 py-1.5 font-medium">Modèle</th>
                <th className="px-2 py-1.5 font-medium">Source</th>
                <th className="px-2 py-1.5 text-right font-medium">Coût</th>
                <th className="px-3 py-1.5 text-right font-medium">Durée</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {runs.data.map((r) => (
                <tr key={r.id} title={r.error ?? r.computeReason ?? undefined}>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <div>{formatShort(r.createdAt)}</div>
                    <div className="text-[11px] text-subtle">{RUN_TRIGGER_LABELS[r.trigger]}</div>
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge tone={r.status === 'error' ? 'danger' : r.status === 'done' ? 'success' : r.status === 'running' ? 'accent' : 'neutral'}>
                      {RUN_STATUS_LABELS[r.status]}
                    </Badge>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{MODEL_LABELS[r.model] ?? r.model}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.computeSource ? COMPUTE_SOURCE_LABELS[r.computeSource] : '—'}</td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">{r.computeSource === 'api' ? formatUsd(r.costUsd) : '—'}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{formatDuration(r.startedAt, r.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
