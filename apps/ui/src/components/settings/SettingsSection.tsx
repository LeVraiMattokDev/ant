import type { ReactNode } from 'react';

export function SettingsSection({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="grid gap-4 border-b border-line py-6 last:border-0 lg:grid-cols-[260px_1fr]">
      <div>
        <h2 className="text-[14.5px] font-semibold">{title}</h2>
        {description && <p className="mt-1 text-[12.5px] text-muted">{description}</p>}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

export function NumberField({
  id,
  label,
  help,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  id: string;
  label: string;
  help?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  const invalid = !Number.isFinite(value) || value < min || value > max;
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          className="input w-32"
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
        />
        {suffix && <span className="text-[13px] text-muted">{suffix}</span>}
      </div>
      {invalid ? <div className="help !text-danger">Entre {min} et {max}.</div> : help && <div className="help">{help}</div>}
    </div>
  );
}
