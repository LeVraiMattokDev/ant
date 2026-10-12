import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MEMORY_KINDS, type BotDTO, type MemoryInput, type MemoryItemDTO, type MemoryKind, type MemoryScope } from '@ant/shared';
import { errorMessage, patch, post } from '../../lib/api';
import { MEMORY_KIND_LABELS } from '../../lib/labels';
import { qk } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { Modal } from '../Modal';
import { Field, Spinner, Toggle, cx } from '../ui';

export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];
}

export function MemoryModal({
  item,
  defaults,
  bots,
  onClose,
}: {
  item: MemoryItemDTO | null;
  defaults: { scope: MemoryScope; botId: string | null };
  bots: BotDTO[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<MemoryScope>(item?.scope ?? defaults.scope);
  const [botId, setBotId] = useState<string>(item?.botId ?? defaults.botId ?? bots[0]?.id ?? '');
  const [kind, setKind] = useState<MemoryKind>(item?.kind ?? 'note');
  const [title, setTitle] = useState(item?.title ?? '');
  const [content, setContent] = useState(item?.content ?? '');
  const [tags, setTags] = useState((item?.tags ?? []).join(', '));
  const [pinned, setPinned] = useState(item?.pinned ?? false);
  const [importance, setImportance] = useState(item?.importance ?? 3);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: MemoryInput) => (item ? patch<MemoryItemDTO>(`/api/memory/${item.id}`, input) : post<MemoryItemDTO>('/api/memory', input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.memoryAll });
      toast.success(item ? 'Souvenir modifié' : 'Souvenir ajouté');
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate({
      scope,
      botId: scope === 'bot' ? botId : null,
      kind,
      title: title.trim(),
      content: content.trim(),
      tags: parseTags(tags),
      pinned,
      importance,
    });
  };

  const valid = title.trim() && content.trim() && (scope === 'shared' || botId);

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? 'Modifier le souvenir' : 'Nouveau souvenir'}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" form="memory-form" className="btn btn-primary" disabled={!valid || save.isPending}>
            {save.isPending && <Spinner className="size-4 text-accent-fg" />}
            Enregistrer
          </button>
        </>
      }
    >
      <form id="memory-form" onSubmit={submit} className="space-y-4">
        {error && <div className="text-[13px] text-danger">{error}</div>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Portée" htmlFor="mem-scope">
            <select id="mem-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value as MemoryScope)}>
              <option value="shared">Partagée (tous les bots)</option>
              <option value="bot">Propre à un bot</option>
            </select>
          </Field>
          {scope === 'bot' && (
            <Field label="Bot" htmlFor="mem-bot">
              <select id="mem-bot" className="select" value={botId} onChange={(e) => setBotId(e.target.value)}>
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Type" htmlFor="mem-kind">
            <select id="mem-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {MEMORY_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Titre" htmlFor="mem-title">
          <input id="mem-title" data-autofocus className="input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Contenu" htmlFor="mem-content" help="Markdown accepté.">
          <textarea id="mem-content" className="textarea min-h-[140px]" value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
        <Field label="Étiquettes" htmlFor="mem-tags" help="Séparées par des virgules.">
          <input id="mem-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="famille, santé" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="label" id="mem-importance">
              Importance
            </div>
            <div className="flex gap-1" role="radiogroup" aria-labelledby="mem-importance">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={importance === n}
                  onClick={() => setImportance(n)}
                  className={cx('btn btn-sm w-9', importance === n && 'border-accent bg-accent-soft text-accent-text')}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <Toggle
            label="Épinglé"
            help="Toujours fourni aux bots concernés, sans qu’ils aient besoin de chercher."
            checked={pinned}
            onChange={setPinned}
          />
        </div>
      </form>
    </Modal>
  );
}
