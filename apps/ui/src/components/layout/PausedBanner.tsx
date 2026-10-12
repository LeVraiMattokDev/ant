import { Link, useLocation } from 'react-router-dom';
import { useQuota } from '../../lib/queries';

export function PausedBanner() {
  const { data } = useQuota();
  const { pathname } = useLocation();
  if (!data?.allPaused) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[13px]">
      <span className="font-semibold text-danger">Bots en pause</span>
      <span className="text-fg">{data.pausedReason ?? 'Aucune source de calcul n’est disponible pour le moment.'}</span>
      {pathname !== '/quota' && (
        <Link to="/quota" className="ml-auto text-accent-text underline">
          Voir le quota
        </Link>
      )}
    </div>
  );
}
