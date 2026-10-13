import { useId, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Spinner({ className, label = 'Chargement' }: { className?: string; label?: string }) {
  return <Loader2 aria-label={label} role="status" className={cx('animate-spin text-subtle', className ?? 'size-4')} />;
}

export function LoadingBlock({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted">
      <Spinner />
      {label}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Erreur inattendue.';
  return (
    <div role="alert" className="m-4 rounded-[12px] border border-danger/40 bg-danger-soft px-4 py-3 text-sm">
      <div className="text-danger">{message}</div>
      {onRetry && (
        <button type="button" className="btn btn-sm mt-2" onClick={onRetry}>
          Réessayer
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center">
      <div className="text-[15px] font-semibold">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Field({
  label,
  help,
  error,
  children,
  htmlFor,
}: {
  label: string;
  help?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <div className="help !text-danger">{error}</div> : help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  help,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  help?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        {help && <div className="text-xs text-subtle">{help}</div>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-[20px] w-[34px] shrink-0 rounded-full border transition-colors disabled:opacity-50',
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-active',
        )}
      >
        <span
          className={cx(
            'absolute top-[2px] left-0 size-[14px] rounded-full shadow-sm transition-transform',
            checked ? 'translate-x-[16px] bg-white' : 'translate-x-[2px] bg-muted',
          )}
        />
      </button>
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'danger' | 'success' | 'warning' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-active text-muted',
  accent: 'border-transparent bg-accent-soft text-accent-text',
  danger: 'border-transparent bg-danger-soft text-danger',
  success: 'border-transparent bg-success-soft text-success',
  warning: 'border-transparent bg-warning-soft text-warning',
  info: 'border-transparent bg-info-soft text-info',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('chip', TONES[tone])}>
      {children}
    </span>
  );
}

export function CountBadge({ count, label }: { count: number; label?: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={label ?? `${count} en attente`}
      className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-accent-fg"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Horizontal gauge. `marks` draws thin ticks (e.g. reserve / hard thresholds). */
export function Gauge({
  value,
  max = 100,
  marks = [],
  label,
}: {
  value: number | null;
  max?: number;
  marks?: { at: number; label: string }[];
  label: string;
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const danger = marks.length ? value !== null && value >= (marks[marks.length - 1]?.at ?? Infinity) : pct >= 90;
  const warn = marks.length ? value !== null && value >= (marks[0]?.at ?? Infinity) : pct >= 70;
  return (
    <div
      // A meter requires a current value: without one (subscription not configured, no data yet) it is an image saying so.
      {...(value === null
        ? { role: 'img', 'aria-label': `${label} : non disponible` }
        : { role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value })}
      className="relative h-2 w-full overflow-hidden rounded-full bg-active"
    >
      <div
        className={cx('h-full transition-[width]', danger ? 'bg-danger' : warn ? 'bg-warning' : 'bg-accent')}
        style={{ width: `${pct}%` }}
      />
      {marks.map((m) => (
        <div
          key={m.label}
          title={m.label}
          className="absolute top-0 h-full w-px bg-fg/60"
          style={{ left: `${Math.min(100, (m.at / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cx('segmented', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const idx = tabs.findIndex((x) => x.id === value);
            let next: number | null = null;
            if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
            if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
            if (next === null) return;
            e.preventDefault();
            onChange(tabs[next]!.id);
            const sibling = e.currentTarget.parentElement?.children[next] as HTMLElement | undefined;
            sibling?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  icon,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 px-4 pt-5 pb-4 md:px-8 md:pt-7">
      <div className="flex min-w-0 items-center gap-3.5">
        {icon}
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
          {description && <div className="mt-1 max-w-2xl text-[13.5px] text-muted">{description}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/** Bare on/off switch (the accessible name comes from `label`). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cx(
        'relative h-[18px] w-[30px] shrink-0 rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-accent bg-accent' : 'border-line-strong bg-active',
      )}
    >
      <span
        className={cx(
          'absolute top-[2px] left-0 size-3 rounded-full shadow-sm transition-transform',
          checked ? 'translate-x-[14px] bg-white' : 'translate-x-[2px] bg-muted',
        )}
      />
    </button>
  );
}
