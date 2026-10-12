import { useMemo, useState } from 'react';
import { MODEL_LABELS, type BotDTO } from '@ant/shared';
import { formatTokens, formatUsd } from '../../lib/format';
import { useBotMap, useUsage } from '../../lib/queries';
import { bucketByDay, groupUsage, type GroupRow, type UsageMetric } from '../../lib/usage';
import { ErrorBlock, LoadingBlock } from '../ui';
import { BotAvatar } from '../BotAvatar';
import type { ReactNode } from 'react';
import { UsageChart } from './UsageChart';

function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function GroupTable({ title, rows, labelOf }: { title: string; rows: GroupRow[]; labelOf: (key: string) => ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-[13px] font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-[13px] text-subtle">Aucune consommation sur la période.</p>
      ) : (
        <div className="overflow-x-auto rounded-[12px] border border-line">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface text-left text-subtle">
              <tr>
                <th className="px-3 py-1.5 font-medium" />
                <th className="px-2 py-1.5 text-right font-medium">Exécutions</th>
                <th className="px-2 py-1.5 text-right font-medium">Tokens</th>
                <th className="px-2 py-1.5 text-right font-medium" title="Valeur estimée au tarif API">Abonnement (équiv.)</th>
                <th className="px-3 py-1.5 text-right font-medium">Crédits API</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap">{labelOf(r.key)}</td>
                  <td className="px-2 py-1.5 text-right">{r.runs}</td>
                  <td className="px-2 py-1.5 text-right" title={`entrée ${r.inputTokens} · sortie ${r.outputTokens} · cache ${r.cacheTokens}`}>
                    {formatTokens(r.inputTokens + r.outputTokens + r.cacheTokens)}
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted">{formatUsd(r.subscriptionCostUsd)}</td>
                  <td className="px-3 py-1.5 text-right">{formatUsd(r.apiCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function botLabel(bots: Map<string, BotDTO>, key: string): ReactNode {
  if (key === '__none') return 'Système (tri, résumés)';
  const b = bots.get(key);
  if (!b) return 'Bot archivé';
  return (
    <span className="inline-flex items-center gap-2">
      <BotAvatar bot={b} size={18} />
      {b.name}
    </span>
  );
}

export function UsageSection() {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const usage = useUsage(days);
  const bots = useBotMap();

  const buckets = useMemo(() => bucketByDay(usage.data ?? [], days, metric), [usage.data, days, metric]);
  const byBot = useMemo(() => groupUsage(usage.data ?? [], (r) => r.botId ?? '__none'), [usage.data]);
  const byModel = useMemo(() => groupUsage(usage.data ?? [], (r) => r.model), [usage.data]);
  const totalSub = buckets.reduce((s, b) => s + b.subscription, 0);
  const totalApi = buckets.reduce((s, b) => s + b.api, 0);
  const fmt = metric === 'cost' ? formatUsd : formatTokens;

  return (
    <section className="card p-4" aria-labelledby="usage-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="usage-title" className="text-[14.5px] font-semibold">
            Consommation
          </h2>
          <p className="text-[12.5px] text-muted">
            {metric === 'cost'
              ? 'Coût par jour. Pour l’abonnement, valeur estimée au tarif API (rien n’est facturé).'
              : 'Tokens par jour (entrée, sortie et cache).'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Segmented
            label="Mesure"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'cost', label: 'Coût' },
              { value: 'tokens', label: 'Tokens' },
            ]}
          />
          <Segmented
            label="Période"
            value={days}
            onChange={setDays}
            options={[
              { value: 7, label: '7 j' },
              { value: 30, label: '30 j' },
              { value: 90, label: '90 j' },
            ]}
          />
        </div>
      </div>

      {usage.isPending ? (
        <LoadingBlock />
      ) : usage.isError ? (
        <ErrorBlock error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]" aria-label="Légende">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[2px] bg-[var(--ant-chart-sub)]" />
              Abonnement <span className="text-muted">{fmt(totalSub)}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[2px] bg-[var(--ant-chart-api)]" />
              Crédits API <span className="text-muted">{fmt(totalApi)}</span>
            </span>
          </div>
          <div className="mt-2">
            <UsageChart data={buckets} metric={metric} />
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-[12.5px] text-muted hover:text-fg">Voir les données jour par jour</summary>
            <div className="mt-2 max-h-72 overflow-auto rounded-[12px] border border-line">
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-surface text-left text-subtle">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Jour</th>
                    <th className="px-2 py-1.5 text-right font-medium">Abonnement</th>
                    <th className="px-3 py-1.5 text-right font-medium">Crédits API</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[...buckets].reverse().map((b) => (
                    <tr key={b.day}>
                      <td className="px-3 py-1">{b.day}</td>
                      <td className="px-2 py-1 text-right">{fmt(b.subscription)}</td>
                      <td className="px-3 py-1 text-right">{fmt(b.api)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <GroupTable title="Par bot" rows={byBot} labelOf={(k) => botLabel(bots, k)} />
            <GroupTable title="Par modèle" rows={byModel} labelOf={(k) => MODEL_LABELS[k] ?? k} />
          </div>
        </>
      )}
    </section>
  );
}
