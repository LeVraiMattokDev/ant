import { useQuery } from '@tanstack/react-query';
import { describeCron } from '@ant/shared';
import { ApiError, post } from '../../lib/api';
import { formatFull } from '../../lib/format';
import { useDebouncedValue } from '../../lib/hooks';
import { Field, Spinner, Toggle } from '../ui';

export interface RoutineFields {
  cron: string;
  timezone: string;
  instruction: string;
  urgent: boolean;
}

interface Preview {
  description: string;
  nextRuns: string[];
}

export function useCronPreview(cron: string, timezone: string) {
  const debounced = useDebouncedValue(cron.trim(), 400);
  return useQuery({
    queryKey: ['routine-preview', debounced, timezone],
    queryFn: () => post<Preview>('/api/routines/preview', { cron: debounced, timezone: timezone || undefined }),
    enabled: debounced.split(/\s+/).length === 5,
    retry: false,
    staleTime: 60_000,
  });
}

/** Editable cron + instruction + urgent, with a live server preview of the next runs. */
export function RoutineEditor({ value, onChange }: { value: RoutineFields; onChange: (v: RoutineFields) => void }) {
  const preview = useCronPreview(value.cron, value.timezone);
  const fiveFields = value.cron.trim().split(/\s+/).length === 5;
  const description = preview.data?.description ?? (fiveFields ? describeCron(value.cron) : null);

  return (
    <div className="space-y-4">
      <div className="rounded-[12px] border border-line bg-bg p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold">{description ?? 'Expression incomplète'}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">Fuseau : {value.timezone || 'fuseau des réglages'}</div>
          </div>
          {preview.isFetching && <Spinner />}
        </div>
        {preview.isError ? (
          <div className="mt-2 text-[12.5px] text-danger">
            {preview.error instanceof ApiError ? preview.error.message : 'Expression cron invalide.'}
          </div>
        ) : preview.data?.nextRuns.length ? (
          <div className="mt-2">
            <div className="section-title">Prochaines exécutions</div>
            <ol className="mt-1 space-y-0.5 text-[13px]">
              {preview.data.nextRuns.slice(0, 3).map((r) => (
                <li key={r}>{formatFull(r)}</li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
        <Field label="Expression cron" htmlFor="routine-cron" help="minute heure jour-du-mois mois jour-de-la-semaine">
          <input
            id="routine-cron"
            className="input mono"
            value={value.cron}
            spellCheck={false}
            onChange={(e) => onChange({ ...value, cron: e.target.value })}
          />
        </Field>
        <Field label="Fuseau horaire" htmlFor="routine-tz">
          <input id="routine-tz" className="input" value={value.timezone} onChange={(e) => onChange({ ...value, timezone: e.target.value })} />
        </Field>
      </div>
      <Field label="Consigne donnée au bot" htmlFor="routine-instruction">
        <textarea
          id="routine-instruction"
          className="textarea min-h-[90px]"
          value={value.instruction}
          onChange={(e) => onChange({ ...value, instruction: e.target.value })}
        />
      </Field>
      <Toggle
        label="Urgente"
        help="Priorité plus haute (passe avant le travail de fond) et notification même pendant les heures de silence si tu l’autorises."
        checked={value.urgent}
        onChange={(v) => onChange({ ...value, urgent: v })}
      />
    </div>
  );
}
