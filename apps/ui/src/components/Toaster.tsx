import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { dismissToast, useToasts, type ToastLevel } from '../lib/toast';
import { cx } from './ui';

const BAR: Record<ToastLevel, string> = {
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
};

/** Toasts carry a server-provided URL: only follow same-origin paths. */
function internalPath(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    return u.origin === window.location.origin ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch {
    return null;
  }
}

export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-3 md:bottom-4 md:right-4 md:left-auto md:items-end"
    >
      {toasts.map((t) => {
        const path = internalPath(t.url);
        return (
          <div
            key={t.id}
            role={t.level === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-sm overflow-hidden rounded-[6px] border border-line bg-surface shadow-pop"
          >
            <div className={cx('w-[3px] shrink-0', BAR[t.level])} />
            <div className="min-w-0 flex-1 px-3 py-2">
              <div className="text-[13px] font-semibold">{t.title}</div>
              {t.body && <div className="mt-0.5 text-[13px] text-muted">{t.body}</div>}
              {path && (
                <Link to={path} onClick={() => dismissToast(t.id)} className="mt-1 inline-block text-[13px] text-accent-text underline">
                  Ouvrir
                </Link>
              )}
            </div>
            <button type="button" aria-label="Fermer la notification" className="btn btn-ghost btn-sm btn-icon m-1" onClick={() => dismissToast(t.id)}>
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
