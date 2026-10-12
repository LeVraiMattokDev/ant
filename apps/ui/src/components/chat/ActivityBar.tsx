import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { BotDTO, RunDTO } from '@ant/shared';
import { post } from '../../lib/api';
import { useActiveRuns } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { Avatar } from '../ui';

function describe(run: RunDTO, bot: BotDTO | undefined): string {
  const name = bot?.name ?? 'Un bot';
  if (run.status === 'queued') return `${name} est en file d’attente`;
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
  const runs = (data ?? []).filter(
    (r) => r.channelId === channelId && (threadRootId ? r.threadRootId === threadRootId : !r.threadRootId),
  );
  if (!runs.length) return null;
  return (
    <div className="shrink-0 space-y-1 px-4 pt-1 md:px-5" aria-live="polite">
      {runs.map((run) => {
        const bot = bots.get(run.botId);
        return (
          <div key={run.id} className="flex items-center gap-2 text-[12.5px] text-muted">
            <Avatar emoji={bot?.avatar} size="sm" />
            <span className="truncate">{describe(run, bot)}</span>
            <span className="flex items-center gap-0.5 text-accent" aria-hidden="true">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm ml-auto"
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
