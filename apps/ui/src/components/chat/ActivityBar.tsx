import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { BotDTO, RunDTO } from '@ant/shared';
import { post } from '../../lib/api';
import { useActiveRuns, useWorkerDown } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { BotAvatar } from '../BotAvatar';

function describe(run: RunDTO, bot: BotDTO | undefined, workerDown = false): string {
  const name = bot?.name ?? 'Un bot';
  if (run.status === 'queued') return workerDown ? `${name} attend le worker` : `${name} est en file d’attente`;
  if (run.status === 'waiting_approval') return `${name} attend ta validation`;
  const act = (run.activity ?? bot?.activity ?? '').trim();
  if (!act) return `${name} réfléchit`;
  // Activities are phrased like "utilise le navigateur".
  return `${name} ${act.charAt(0).toLowerCase()}${act.slice(1).replace(/[.…]+$/, '')}`;
}

export function useCancelRun() {
  return useMutation({
    mutationFn: (id: string) => post(`/api/runs/${id}/cancel`),
    onSuccess: () => toast.info('Annulation demandée'),
    onError: (err) => toast.fromError(err, 'Annulation impossible'),
  });
}

/** Live "Dev utilise le navigateur…" indicators with a cancel button, for the runs of a channel (or one thread). */
export function ActivityBar({
  channelId,
  threadRootId,
  bots,
}: {
  channelId: string;
  /** undefined = top-level conversation; string = this thread only. */
  threadRootId?: string;
  bots: Map<string, BotDTO>;
}) {
  const { data } = useActiveRuns();
  const cancel = useCancelRun();
  const workerDown = useWorkerDown();
  const runs = (data ?? []).filter(
    (r) => r.channelId === channelId && (threadRootId ? r.threadRootId === threadRootId : !r.threadRootId),
  );
  if (!runs.length) return null;
  return (
    <div className="mx-auto flex w-full max-w-[880px] shrink-0 flex-wrap gap-1.5 px-4 pt-1 pb-1 md:px-6" aria-live="polite">
      {workerDown && (
        <div role="status" className="w-full rounded-[12px] border border-warning/40 bg-warning-soft px-3 py-1.5 text-[12.5px] text-fg">
          Le worker ne répond pas : les bots ne peuvent pas travailler pour l’instant (voir <code>docker compose logs worker</code>).
        </div>
      )}
      {runs.map((run) => {
        const bot = bots.get(run.botId);
        return (
          <div key={run.id} className="flex max-w-full items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-1.5 text-[12.5px] text-muted">
            <BotAvatar bot={bot} size={20} />
            <span className="truncate">{describe(run, bot, workerDown)}</span>
            <span className="flex items-center gap-0.5 text-accent" aria-hidden="true">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-round !h-6 !px-2"
              onClick={() => cancel.mutate(run.id)}
              disabled={cancel.isPending && cancel.variables === run.id}
              aria-label={`Annuler l’exécution de ${bot?.name ?? 'ce bot'}`}
            >
              <X className="size-3.5" />
              Annuler
            </button>
          </div>
        );
      })}
    </div>
  );
}
