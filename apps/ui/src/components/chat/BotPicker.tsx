import type { BotDTO } from '@ant/shared';
import { Avatar, cx } from '../ui';

/** Multi-select list of bots (checkboxes). */
export function BotPicker({ bots, value, onChange }: { bots: BotDTO[]; value: string[]; onChange: (ids: string[]) => void }) {
  if (!bots.length) return <div className="text-[13px] text-subtle">Aucun bot. Crée d’abord un bot.</div>;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-[6px] border border-line">
      {bots.map((b) => {
        const checked = value.includes(b.id);
        return (
          <li key={b.id}>
            <label className={cx('flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-hover', checked && 'bg-accent-soft/40')}>
              <input type="checkbox" className="accent-[var(--ant-accent)]" checked={checked} onChange={() => toggle(b.id)} />
              <Avatar emoji={b.avatar} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">{b.name}</span>
                <span className="block truncate text-[12px] text-subtle">{b.role}</span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
