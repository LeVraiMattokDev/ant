import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  COMPUTE_MODE_LABELS,
  COMPUTE_MODES,
  type ComputeMode,
  type QuotaStatusDTO,
  type QuotaThresholds,
  type SettingsDTO,
  type SubscriptionHealth,
} from '@ant/shared';
import { post } from '../../lib/api';
import { formatDate, formatFull, formatPercent, formatRelative, formatTokens, formatUsd, toDateInput } from '../../lib/format';
import { COMPUTE_MODE_HELP, HEALTH_LABELS } from '../../lib/labels';
import { qk } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { useUpdateSettings } from '../settings/useUpdateSettings';
import { Badge, Gauge, KeyValue, Spinner, cx } from '../ui';

const HEALTH_TONE: Record<SubscriptionHealth, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success',
  warning: 'warning',
  limited: 'danger',
  auth_failed: 'danger',
  unknown: 'neutral',
  not_configured: 'neutral',
};

function CardShell({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[14.5px] font-semibold">{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  );
}

export function ComputeModeSelector({ mode }: { mode: ComputeMode }) {
  const update = useUpdateSettings('Mode de calcul modifié');
  return (
    <CardShell title="Mode de calcul">
      <div className="grid gap-2 md:grid-cols-2" role="radiogroup" aria-label="Mode de calcul">
        {COMPUTE_MODES.map((m) => {
          const selected = m === mode;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={update.isPending}
              onClick={() => !selected && update.mutate({ computeMode: m })}
              className={cx(
                'rounded-[12px] border p-3 text-left transition-colors',
                selected ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong hover:bg-hover',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cx('size-3.5 shrink-0 rounded-full border-2', selected ? 'border-accent bg-accent' : 'border-line-strong')} />
                <span className="text-[13.5px] font-semibold">{m === 'hybrid_safe' ? 'Hybride prudent' : COMPUTE_MODE_LABELS[m]}</span>
                {m === 'hybrid_safe' && <Badge tone="accent">Recommandé</Badge>}
              </div>
              <p className="mt-1.5 pl-5.5 text-[12.5px] leading-relaxed text-muted">{COMPUTE_MODE_HELP[m]}</p>
            </button>
          );
        })}
      </div>
    </CardShell>
  );
}

function windowLine(label: string, util: number | null, resetsAt: string | null, reserve: number, hard: number) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
        <span className="font-medium">{label}</span>
        <span>
          {formatPercent(util)}
          {resetsAt && (
            <span className="ml-2 text-subtle" title={formatFull(resetsAt)}>
              réinitialisation {formatRelative(resetsAt)}
            </span>
          )}
        </span>
      </div>
      <Gauge
        label={label}
        value={util}
        marks={[
          { at: reserve, label: `Réserve ${reserve} %` },
          { at: hard, label: `Maximum ${hard} %` },
        ]}
      />
      <div className="mt-0.5 text-[11px] text-subtle">
        réserve {reserve} % · maximum {hard} %
      </div>
    </div>
  );
}

export function SubscriptionCard({ quota, settings }: { quota: QuotaStatusDTO; settings: SettingsDTO | undefined }) {
  const qc = useQueryClient();
  const sub = quota.subscription;
  const t = quota.thresholds;
  const updateSettings = useUpdateSettings('Date du jeton enregistrée');
  const [tokenDate, setTokenDate] = useState(toDateInput(settings?.subscriptionTokenCreatedAt ?? sub.tokenCreatedAt));
  useEffect(() => setTokenDate(toDateInput(settings?.subscriptionTokenCreatedAt ?? sub.tokenCreatedAt)), [settings?.subscriptionTokenCreatedAt, sub.tokenCreatedAt]);

  const reset = useMutation({
    mutationFn: () => post<QuotaStatusDTO>('/api/quota/subscription/reset'),
    onSuccess: (q) => {
      qc.setQueryData(qk.quota, q);
      toast.success('Limite levée', 'Les prochaines exécutions réessaieront l’abonnement.');
    },
    onError: (err) => toast.fromError(err, 'Impossible de lever la limite'),
  });

  const daysLeft = sub.tokenExpiresAt ? Math.floor((new Date(sub.tokenExpiresAt).getTime() - Date.now()) / 86_400_000) : null;
  const limited = sub.health === 'limited' || (sub.limitedUntil !== null && new Date(sub.limitedUntil).getTime() > Date.now());

  return (
    <CardShell title="Abonnement Claude" badge={<Badge tone={HEALTH_TONE[sub.health]}>{HEALTH_LABELS[sub.health]}</Badge>}>
      {!sub.configured ? (
        <p className="text-[13px] text-muted">
          Aucun jeton d’abonnement configuré. Génère-en un avec <span className="mono">claude setup-token</span> et place-le dans la variable
          <span className="mono"> CLAUDE_CODE_OAUTH_TOKEN</span> du service worker.
        </p>
      ) : (
        <div className="space-y-4">
          {sub.health === 'auth_failed' && (
            <div className="rounded-[8px] border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              Le jeton a été refusé (expiré ou révoqué). Génère un nouveau jeton avec <span className="mono">claude setup-token</span>.
            </div>
          )}
          {windowLine('Fenêtre de 5 heures', sub.fiveHour.utilization, sub.fiveHour.resetsAt, t.reserveFiveHour, t.hardFiveHour)}
          {windowLine('Semaine', sub.sevenDay.utilization, sub.sevenDay.resetsAt, t.reserveWeekly, t.hardWeekly)}
          <div className="divide-y divide-line border-t border-line pt-1">
            {sub.limitedUntil && (
              <KeyValue label="Limité jusqu’à">
                <span className="text-danger">{formatFull(sub.limitedUntil)}</span>
              </KeyValue>
            )}
            <KeyValue label="Tokens utilisés par Ant aujourd’hui">{formatTokens(sub.antTokensToday)}</KeyValue>
            <KeyValue label="Valeur équivalente au tarif API">{formatUsd(sub.antEquivalentUsdToday)}</KeyValue>
            <KeyValue label="Dernier signal de quota">{sub.lastEventAt ? formatRelative(sub.lastEventAt) : '—'}</KeyValue>
            <KeyValue label="Expiration du jeton">
              {sub.tokenExpiresAt ? (
                <span className={cx(daysLeft !== null && daysLeft <= 30 && 'text-warning', daysLeft !== null && daysLeft <= 0 && 'text-danger')}>
                  {formatDate(sub.tokenExpiresAt)}
                  {daysLeft !== null && ` (${daysLeft > 0 ? `dans ${daysLeft} j` : 'expiré'})`}
                </span>
              ) : (
                'inconnue'
              )}
            </KeyValue>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="label" htmlFor="token-created">
                Jeton créé le
              </label>
              <input id="token-created" type="date" className="input w-44" value={tokenDate} onChange={(e) => setTokenDate(e.target.value)} />
            </div>
            <button
              type="button"
              className="btn"
              disabled={updateSettings.isPending || tokenDate === toDateInput(settings?.subscriptionTokenCreatedAt ?? null)}
              onClick={() =>
                updateSettings.mutate({ subscriptionTokenCreatedAt: tokenDate ? new Date(`${tokenDate}T12:00:00`).toISOString() : null })
              }
            >
              Enregistrer la date
            </button>
          </div>
          <p className="text-[12px] text-subtle">Le jeton est valable un an. Ant te prévient 30 jours avant son expiration.</p>
          <div className="border-t border-line pt-3">
            <button type="button" className="btn" disabled={!limited || reset.isPending} onClick={() => reset.mutate()}>
              {reset.isPending && <Spinner />}
              Lever la limite manuellement
            </button>
            <p className="help">Utile si tu sais que la limite est déjà réinitialisée (par exemple après un changement d’offre).</p>
          </div>
        </div>
      )}
    </CardShell>
  );
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  return <Gauge label={label} value={max > 0 ? (value / max) * 100 : 0} marks={[]} />;
}

export function ApiCard({ quota, settings }: { quota: QuotaStatusDTO; settings: SettingsDTO | undefined }) {
  const api = quota.api;
  const update = useUpdateSettings('Plafonds enregistrés');
  const [daily, setDaily] = useState(String(settings?.apiDailyCapUsd ?? api.dailyCapUsd));
  const [monthly, setMonthly] = useState(String(settings?.apiMonthlyCapUsd ?? api.monthlyCapUsd));
  const [perRun, setPerRun] = useState(String(settings?.perRunCapUsd ?? ''));
  useEffect(() => {
    if (!settings) return;
    setDaily(String(settings.apiDailyCapUsd));
    setMonthly(String(settings.apiMonthlyCapUsd));
    setPerRun(String(settings.perRunCapUsd));
  }, [settings]);

  const d = Number(daily.replace(',', '.'));
  const m = Number(monthly.replace(',', '.'));
  const r = Number(perRun.replace(',', '.'));
  const valid = d >= 0 && m >= 0 && d <= m && r >= 0.05 && Number.isFinite(d + m + r);
  const dirty = !!settings && (d !== settings.apiDailyCapUsd || m !== settings.apiMonthlyCapUsd || r !== settings.perRunCapUsd);

  return (
    <CardShell
      title="Crédits API"
      badge={
        !api.configured ? <Badge>Non configurés</Badge> : api.authFailed ? <Badge tone="danger">Clé refusée</Badge> : <Badge tone="success">Disponibles</Badge>
      }
    >
      {!api.configured && (
        <p className="mb-3 text-[13px] text-muted">
          Aucune clé API configurée (<span className="mono">ANTHROPIC_API_KEY</span> du service worker). Le travail autonome ne peut pas tourner en mode hybride.
        </p>
      )}
      <div className="space-y-4">
        <div>
          <div className="mb-1 flex justify-between text-[12.5px]">
            <span className="font-medium">Aujourd’hui</span>
            <span>
              {formatUsd(api.spentTodayUsd)} <span className="text-subtle">/ {formatUsd(api.dailyCapUsd)}</span>
            </span>
          </div>
          <Bar label="Dépenses API du jour" value={api.spentTodayUsd} max={api.dailyCapUsd} />
        </div>
        <div>
          <div className="mb-1 flex justify-between text-[12.5px]">
            <span className="font-medium">Ce mois</span>
            <span>
              {formatUsd(api.spentMonthUsd)} <span className="text-subtle">/ {formatUsd(api.monthlyCapUsd)}</span>
            </span>
          </div>
          <Bar label="Dépenses API du mois" value={api.spentMonthUsd} max={api.monthlyCapUsd} />
        </div>
        <form
          className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) update.mutate({ apiDailyCapUsd: d, apiMonthlyCapUsd: m, perRunCapUsd: r });
          }}
        >
          <div>
            <label className="label" htmlFor="cap-day">
              Plafond quotidien ($)
            </label>
            <input id="cap-day" className="input" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="cap-month">
              Plafond mensuel ($)
            </label>
            <input id="cap-month" className="input" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="cap-run">
              Par exécution ($)
            </label>
            <input id="cap-run" className="input" inputMode="decimal" value={perRun} onChange={(e) => setPerRun(e.target.value)} />
          </div>
          {!valid && <div className="text-[12px] text-danger sm:col-span-3">Montants invalides : quotidien ≤ mensuel, et au moins 0,05 $ par exécution.</div>}
          <div className="sm:col-span-3">
            <button type="submit" className="btn" disabled={!valid || !dirty || update.isPending}>
              {update.isPending && <Spinner />}
              Enregistrer les plafonds
            </button>
          </div>
        </form>
      </div>
    </CardShell>
  );
}

export function ThresholdsCard({ thresholds, settings }: { thresholds: QuotaThresholds; settings: SettingsDTO | undefined }) {
  const update = useUpdateSettings('Seuils enregistrés');
  const [t, setT] = useState<QuotaThresholds>(thresholds);
  const [alerts, setAlerts] = useState((settings?.alertThresholds ?? [50, 80, 95]).join(', '));
  useEffect(() => setT(thresholds), [thresholds]);
  useEffect(() => {
    if (settings) setAlerts(settings.alertThresholds.join(', '));
  }, [settings]);

  const alertValues = alerts
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number);
  const alertsValid = alertValues.length >= 1 && alertValues.length <= 6 && alertValues.every((v) => Number.isFinite(v) && v >= 1 && v <= 100);
  const inRange = (Object.values(t) as number[]).every((v) => Number.isFinite(v) && v >= 1 && v <= 100);
  const ordered = t.reserveFiveHour <= t.hardFiveHour && t.reserveWeekly <= t.hardWeekly;
  const valid = inRange && ordered && alertsValid;

  const field = (key: keyof QuotaThresholds, label: string) => (
    <div>
      <label className="label" htmlFor={`th-${key}`}>
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          id={`th-${key}`}
          type="number"
          min={1}
          max={100}
          className="input w-24"
          value={Number.isFinite(t[key]) ? t[key] : ''}
          onChange={(e) => setT({ ...t, [key]: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
        />
        <span className="text-[13px] text-muted">%</span>
      </div>
    </div>
  );

  return (
    <CardShell title="Seuils">
      <p className="mb-3 text-[12.5px] text-muted">
        Au-delà du seuil de <strong className="font-medium text-fg">réserve</strong>, le travail de fond quitte l’abonnement pour te laisser de la marge. Au-delà du
        seuil <strong className="font-medium text-fg">maximal</strong>, tout le quitte.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) update.mutate({ thresholds: t, alertThresholds: [...new Set(alertValues)].sort((a, b) => a - b) });
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-2 gap-3">
          {field('reserveFiveHour', 'Réserve 5 h')}
          {field('hardFiveHour', 'Maximum 5 h')}
          {field('reserveWeekly', 'Réserve semaine')}
          {field('hardWeekly', 'Maximum semaine')}
        </div>
        <div>
          <label className="label" htmlFor="alert-thresholds">
            Alertes à (%)
          </label>
          <input id="alert-thresholds" className="input max-w-56" value={alerts} onChange={(e) => setAlerts(e.target.value)} />
          <div className="help">Une notification quand l’abonnement ou le budget API franchit ces pourcentages.</div>
        </div>
        {!ordered && <div className="text-[12px] text-danger">Chaque seuil de réserve doit être inférieur ou égal au seuil maximal.</div>}
        {!alertsValid && <div className="text-[12px] text-danger">De 1 à 6 valeurs entre 1 et 100.</div>}
        <button type="submit" className="btn" disabled={!valid || update.isPending}>
          {update.isPending && <Spinner />}
          Enregistrer les seuils
        </button>
      </form>
    </CardShell>
  );
}
