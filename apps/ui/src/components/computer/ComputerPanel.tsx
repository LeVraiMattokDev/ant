import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Hand, Maximize2, RotateCcw, X } from 'lucide-react';
import { formatRelative } from '../../lib/format';
import { useBotMap, useComputerStatus } from '../../lib/queries';
import { BotAvatar } from '../BotAvatar';
import { Badge, Spinner } from '../ui';
import { useComputerControl } from './useComputerControl';
import { VncScreen } from './VncScreen';

/** Live view of the agents' computer, docked to the right of the conversation (desktop). */
export default function ComputerPanel({ onClose }: { onClose: () => void }) {
  const status = useComputerStatus();
  const bots = useBotMap();
  const control = useComputerControl();
  const s = status.data;
  const online = !!s?.online && !status.isError;
  const userHolds = s?.holder === 'user';
  const active = s?.activeBotId ? bots.get(s.activeBotId) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"], [role="menu"]')) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section
      aria-label="Ordinateur des agents"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[520px] flex-col border-l border-line bg-surface shadow-pop xl:static xl:z-auto xl:w-[480px] xl:shrink-0 xl:shadow-none 2xl:w-[560px]"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 px-4">
        <h2 className="text-[15px] font-semibold">Ordinateur</h2>
        {s && <Badge tone={online ? 'success' : 'danger'}>{online ? 'En ligne' : 'Hors ligne'}</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Link to="/computer" className="btn btn-ghost btn-sm btn-icon" aria-label="Ouvrir en plein écran" title="Ouvrir en plein écran">
            <Maximize2 className="size-4" />
          </Link>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Fermer le panneau de l’ordinateur">
            <X className="size-4" />
          </button>
        </div>
      </header>
      <div className="scroll-y flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
        {status.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !online ? (
          <div role="alert" className="rounded-[14px] border border-line bg-card p-4 text-[13px] text-muted">
            <div className="font-semibold text-fg">Ordinateur des agents injoignable</div>
            <p className="mt-1">
              Le service <span className="mono">computer</span> ne répond pas : les bots ne peuvent utiliser ni le terminal, ni le navigateur, ni les fichiers.
            </p>
          </div>
        ) : (
          <>
            <div className="aspect-[16/10] w-full">
              <VncScreen interactive={userHolds} />
            </div>
            <button
              type="button"
              className={userHolds ? 'btn' : 'btn btn-primary'}
              disabled={control.isPending}
              onClick={() => control.mutate(userHolds ? 'agents' : 'user')}
            >
              {control.isPending ? <Spinner /> : userHolds ? <RotateCcw className="size-4" /> : <Hand className="size-4" />}
              {userHolds ? 'Rendre la main aux agents' : 'Prendre la main'}
            </button>
          </>
        )}
        {s && (
          <dl className="space-y-1.5 rounded-[14px] bg-card px-3.5 py-3 text-[12.5px]">
            <div className="flex justify-between gap-3">
              <dt className="text-subtle">Contrôle</dt>
              <dd>
                {s.holder === 'user' ? 'toi' : 'les agents'} <span className="text-subtle">· {formatRelative(s.since)}</span>
              </dd>
            </div>
            {active && (
              <div className="flex justify-between gap-3">
                <dt className="text-subtle">Bot actif</dt>
                <dd className="flex items-center gap-1.5">
                  <BotAvatar bot={active} size={16} />
                  {active.name}
                </dd>
              </div>
            )}
            {s.lastAction && (
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-subtle">Dernière action</dt>
                <dd className="min-w-0 truncate text-right">{s.lastAction}</dd>
              </div>
            )}
            {s.url && (
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-subtle">Page</dt>
                <dd className="mono min-w-0 truncate text-right text-muted" title={s.url}>
                  {s.url}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}
