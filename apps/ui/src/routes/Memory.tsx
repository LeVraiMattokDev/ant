import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pin, PinOff, Plus, Search } from 'lucide-react';
import { MEMORY_KINDS, type MemoryItemDTO } from '@ant/shared';
import { del, patch } from '../lib/api';
import { formatFull, formatShort } from '../lib/format';
import { useDebouncedValue } from '../lib/hooks';
import { MEMORY_KIND_LABELS } from '../lib/labels';
import { qk, useBotMap, useBots, useMemory } from '../lib/queries';
import { toast } from '../lib/toast';
import { Markdown } from '../components/Markdown';
import { useConfirm } from '../components/Modal';
import { MemoryModal } from '../components/memory/MemoryModal';
import { Badge, EmptyState, ErrorBlock, LoadingBlock, PageHeader, Tabs, cx } from '../components/ui';

export function sortMemory(items: MemoryItemDTO[]): MemoryItemDTO[] {
  return [...items].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt),
  );
}

function Importance({ value }: { value: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`Importance ${value} sur 5`} title={`Importance ${value}/5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={cx('size-1.5 rounded-full', n <= value ? 'bg-accent' : 'bg-line-strong')} />
      ))}
    </span>
  );
}

function MemoryRow({ item, onEdit }: { item: MemoryItemDTO; onEdit: () => void }) {
  const qc = useQueryClient();
  const bots = useBotMap();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const author = item.authorKind === 'user' ? 'toi' : (bots.get(item.authorBotId ?? '')?.name ?? 'un bot');

  const pin = useMutation({
    mutationFn: () => patch<MemoryItemDTO>(`/api/memory/${item.id}`, { pinned: !item.pinned }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.memoryAll }),
    onError: (err) => toast.fromError(err),
  });
  const remove = useMutation({
    mutationFn: () => del(`/api/memory/${item.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.memoryAll });
      toast.success('Souvenir supprimé définitivement');
    },
    onError: (err) => toast.fromError(err, 'Suppression impossible'),
  });

  const long = item.content.length > 280;

  return (
    <li className={cx('px-4 py-3 md:px-6', item.pinned && 'bg-accent-soft/25')}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {item.pinned && <Pin className="size-3.5 text-accent-text" aria-label="Épinglé" />}
            <h3 className="text-[14px] font-semibold">{item.title}</h3>
            <Badge>{MEMORY_KIND_LABELS[item.kind]}</Badge>
            <Importance value={item.importance} />
          </div>
          <div className={cx('mt-1 text-[13.5px]', !expanded && long && 'line-clamp-4')}>
            <Markdown source={item.content} />
          </div>
          {long && (
            <button type="button" className="mt-1 text-[12.5px] text-accent-text hover:underline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Réduire' : 'Tout afficher'}
            </button>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-subtle">
            {item.tags.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
            <span title={formatFull(item.updatedAt)}>
              par {author} · {formatShort(item.updatedAt)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={() => pin.mutate()}
            disabled={pin.isPending}
            aria-label={item.pinned ? 'Désépingler' : 'Épingler'}
            title={item.pinned ? 'Désépingler' : 'Épingler'}
          >
            {item.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>
            Modifier
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm text-danger"
            disabled={remove.isPending}
            onClick={() =>
              void confirm({
                title: 'Supprimer ce souvenir ?',
                body: `« ${item.title} » sera effacé définitivement. Les bots ne pourront plus s’en servir.`,
                confirmLabel: 'Supprimer',
                danger: true,
              }).then((ok) => ok && remove.mutate())
            }
          >
            Supprimer
          </button>
        </div>
      </div>
    </li>
  );
}

export function MemoryPage() {
  const bots = useBots();
  const [tab, setTab] = useState<string>('shared');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [modal, setModal] = useState<{ item: MemoryItemDTO | null } | null>(null);
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const scope = tab === 'shared' ? 'shared' : 'bot';
  const memory = useMemory({ scope, botId: scope === 'bot' ? tab : undefined, q: debouncedQ || undefined, kind: kind || undefined });

  const tabs = [{ id: 'shared', label: 'Partagée' }, ...(bots.data ?? []).map((b) => ({ id: b.id, label: `${b.avatar} ${b.name}` }))];
  const items = sortMemory(memory.data ?? []);

  return (
    <>
      <PageHeader
        title="Mémoire"
        description="Ce que les bots savent de toi et de tes projets. Les éléments épinglés leur sont toujours fournis."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setModal({ item: null })}>
            <Plus className="size-4" />
            Ajouter
          </button>
        }
      />
      <div className="px-4 md:px-6">
        <Tabs label="Portée de la mémoire" tabs={tabs} value={tab} onChange={setTab} />
      </div>
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2.5 md:px-6">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
          <input type="search" className="input pl-8" placeholder="Rechercher dans la mémoire…" aria-label="Rechercher dans la mémoire" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select w-44" aria-label="Filtrer par type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Tous les types</option>
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {MEMORY_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="scroll-y flex-1">
        {memory.isPending ? (
          <LoadingBlock />
        ) : memory.isError ? (
          <ErrorBlock error={memory.error} onRetry={() => void memory.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title={debouncedQ || kind ? 'Aucun résultat' : 'Rien en mémoire ici'}>
            {debouncedQ || kind
              ? 'Essaie d’autres mots ou un autre type.'
              : 'Ajoute ce que les bots devraient savoir : qui tu es, tes préférences, tes projets en cours.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((it) => (
              <MemoryRow key={it.id} item={it} onEdit={() => setModal({ item: it })} />
            ))}
          </ul>
        )}
      </div>
      {modal && (
        <MemoryModal
          item={modal.item}
          defaults={{ scope, botId: scope === 'bot' ? tab : null }}
          bots={bots.data ?? []}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
