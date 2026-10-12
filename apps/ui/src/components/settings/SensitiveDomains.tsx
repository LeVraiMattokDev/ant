import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { DEFAULT_SENSITIVE_DOMAINS } from '@ant/shared';

export function normaliseDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export function SensitiveDomains({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const add = (e: FormEvent) => {
    e.preventDefault();
    const items = input.split(/[\s,]+/).filter(Boolean);
    const valid: string[] = [];
    for (const raw of items) {
      const d = normaliseDomain(raw);
      if (!d) {
        setError(`« ${raw} » n’est pas un domaine valide.`);
        return;
      }
      valid.push(d);
    }
    setError(null);
    onChange([...new Set([...value, ...valid])]);
    setInput('');
  };

  const shown = filter ? value.filter((d) => d.includes(filter.toLowerCase())) : value;

  return (
    <div>
      <form onSubmit={add} className="flex gap-2">
        <input
          className="input"
          placeholder="exemple.com"
          aria-label="Ajouter un domaine sensible"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="btn" disabled={!input.trim()}>
          Ajouter
        </button>
      </form>
      {error && <div className="help !text-danger">{error}</div>}
      <div className="mt-3 flex items-center justify-between gap-2">
        <input
          type="search"
          className="input h-7 max-w-56 text-[12.5px]"
          placeholder={`Filtrer (${value.length} domaines)`}
          aria-label="Filtrer les domaines"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...DEFAULT_SENSITIVE_DOMAINS])}>
          Restaurer la liste par défaut
        </button>
      </div>
      <ul className="mt-2 flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
        {shown.map((d) => (
          <li key={d} className="chip h-6 pr-0.5 text-[12px] text-fg">
            <span className="mono">{d}</span>
            <button
              type="button"
              className="rounded-[6px] p-0.5 text-subtle hover:bg-hover hover:text-fg"
              aria-label={`Retirer ${d}`}
              onClick={() => onChange(value.filter((x) => x !== d))}
            >
              <X className="size-3" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
