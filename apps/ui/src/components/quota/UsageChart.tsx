import { useEffect, useRef, useState } from 'react';
import type { DayBucket, UsageMetric } from '../../lib/usage';
import { niceScale } from '../../lib/usage';
import { formatTokens, formatUsd } from '../../lib/format';

const M = { top: 10, right: 8, bottom: 24, left: 52 };
const HEIGHT = 220;
const GAP = 2;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setW(Math.max(280, Math.floor(width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Bar with only its top corners rounded (data end), square at the baseline. */
function topRoundedBar(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

const dayLabel = (day: string) => {
  const [, m, d] = day.split('-');
  return `${Number(d)}.${Number(m)}`;
};

const longDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('fr-CH', { weekday: 'short', day: 'numeric', month: 'long' });

export function UsageChart({ data, metric }: { data: DayBucket[]; metric: UsageMetric }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const fmt = metric === 'cost' ? formatUsd : formatTokens;
  const axisFmt = metric === 'cost' ? (v: number) => `$${v < 10 && v % 1 ? v.toFixed(2) : v.toFixed(0)}` : formatTokens;

  const totals = data.map((d) => d.subscription + d.api);
  const scale = niceScale(Math.max(0, ...totals));
  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;
  const band = innerW / Math.max(1, data.length);
  const barW = Math.max(3, Math.min(22, band * 0.68));
  const y = (v: number) => M.top + innerH - (v / scale.max) * innerH;
  const ticks: number[] = [];
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) ticks.push(v);
  const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(innerW / 54)));
  const hovered = hover !== null ? data[hover] : undefined;

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={HEIGHT} role="img" aria-label={`Consommation quotidienne par source de calcul, ${data.length} derniers jours`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--ant-line)" strokeWidth={1} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--ant-subtle)">
              {axisFmt(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = M.left + band * i + band / 2;
          const x = cx - barW / 2;
          const subH = d.subscription > 0 ? Math.max(1, (d.subscription / scale.max) * innerH) : 0;
          const apiH = d.api > 0 ? Math.max(1, (d.api / scale.max) * innerH) : 0;
          const base = M.top + innerH;
          const gap = subH && apiH ? GAP : 0;
          const dim = hover !== null && hover !== i;
          return (
            <g key={d.day} opacity={dim ? 0.45 : 1}>
              {subH > 0 &&
                (apiH > 0 ? (
                  <rect x={x} y={base - subH} width={barW} height={subH} fill="var(--ant-chart-sub)" />
                ) : (
                  <path d={topRoundedBar(x, base - subH, barW, subH, 4)} fill="var(--ant-chart-sub)" />
                ))}
              {apiH > 0 && <path d={topRoundedBar(x, base - subH - gap - apiH, barW, apiH, 4)} fill="var(--ant-chart-api)" />}
              {i % labelEvery === 0 && (
                <text x={cx} y={HEIGHT - 6} textAnchor="middle" fontSize={11} fill="var(--ant-subtle)">
                  {dayLabel(d.day)}
                </text>
              )}
              <rect
                x={M.left + band * i}
                y={M.top}
                width={band}
                height={innerH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${longDay(d.day)} : abonnement ${fmt(d.subscription)}, crédits API ${fmt(d.api)}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              />
            </g>
          );
        })}
        <line x1={M.left} x2={width - M.right} y1={M.top + innerH} y2={M.top + innerH} stroke="var(--ant-line-strong)" />
      </svg>
      {hovered && hover !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 min-w-40 rounded-[6px] border border-line bg-surface px-2.5 py-2 text-[12px] shadow-pop"
          style={{
            left: Math.min(width - 170, Math.max(0, M.left + band * hover + band / 2 - 80)),
            top: 0,
          }}
        >
          <div className="mb-1 font-semibold">{longDay(hovered.day)}</div>
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted">
              <span className="size-2 rounded-[2px] bg-[var(--ant-chart-sub)]" />
              Abonnement
            </span>
            <span>{fmt(hovered.subscription)}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted">
              <span className="size-2 rounded-[2px] bg-[var(--ant-chart-api)]" />
              Crédits API
            </span>
            <span>{fmt(hovered.api)}</span>
          </div>
          <div className="mt-1 flex justify-between gap-4 border-t border-line pt-1">
            <span className="text-muted">Total</span>
            <span className="font-semibold">{fmt(hovered.subscription + hovered.api)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
