import { Link, useLocation } from 'react-router-dom';
import { formatRelative } from '../../lib/format';
import { useQuota, useWorkerDown } from '../../lib/queries';

/** The worker, which runs every bot, stopped answering: nothing gets done until it is back. */
function WorkerDownBanner() {
  const down = useWorkerDown();
  const { data } = useQuota();
  if (!down) return null;
  const seen = data?.worker?.lastSeenAt;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[13px]">
      <span className="font-semibold text-danger">Le worker ne répond pas</span>
      <span className="text-fg">
        Les bots ne peuvent pas travailler{seen ? ` (dernier signe de vie ${formatRelative(seen)})` : ''}. Vérifie{' '}
        <code>docker compose logs worker</code>.
      </span>
    </div>
  );
}

export function PausedBanner() {
  const { data } = useQuota();
  const { pathname } = useLocation();
  return (
    <>
      <WorkerDownBanner />
      {data?.allPaused && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[13px]">
          <span className="font-semibold text-danger">Bots en pause</span>
          <span className="text-fg">{data.pausedReason ?? 'Aucune source de calcul n’est disponible pour le moment.'}</span>
          {pathname !== '/quota' && (
            <Link to="/quota" className="ml-auto text-accent-text underline">
              Voir le quota
            </Link>
          )}
        </div>
      )}
    </>
  );
}
