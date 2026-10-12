import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotDTO, ChannelDTO, RoutineDTO, RoutineDraftDTO, RoutineInput } from '@ant/shared';
import { errorMessage, post } from '../../lib/api';
import { qk } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { Field, Spinner } from '../ui';
import { RoutineEditor, type RoutineFields } from './RoutineEditor';

const EXAMPLES = [
  'chaque lundi à 8h, fais-moi un point sur les tâches de la semaine',
  'tous les jours à 18h30, résume ce qui s’est passé dans #projet',
  'le 1er de chaque mois à 9h, prépare le bilan des dépenses',
];

export function NewRoutine({ bots, channels, onDone }: { bots: BotDTO[]; channels: ChannelDTO[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [botId, setBotId] = useState(bots[0]?.id ?? '');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<(RoutineFields & { description: string }) | null>(null);
  const [channelId, setChannelId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const bot = bots.find((b) => b.id === botId);
  const botChannels = channels.filter((c) => c.kind === 'group' && c.botIds.includes(botId));

  const parse = useMutation({
    mutationFn: () => post<RoutineDraftDTO>('/api/routines/parse', { text: text.trim(), botId }),
    onSuccess: (d) => {
      setError(null);
      setDraft({ cron: d.cron, timezone: d.timezone, instruction: d.instruction, urgent: d.urgent, description: d.description });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const create = useMutation({
    mutationFn: (input: RoutineInput) => post<RoutineDTO>('/api/routines', input),
    onSuccess: (r) => {
      qc.setQueryData<RoutineDTO[]>(qk.routines, (d) => (d ? [r, ...d] : d));
      void qc.invalidateQueries({ queryKey: qk.routines });
      toast.success('Routine créée', r.description);
      onDone();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const submitText = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !botId) return;
    setDraft(null);
    parse.mutate();
  };

  const confirm = () => {
    if (!draft) return;
    create.mutate({
      botId,
      channelId: channelId || null,
      sourceText: text.trim(),
      cron: draft.cron.trim(),
      timezone: draft.timezone.trim() || undefined,
      instruction: draft.instruction.trim(),
      urgent: draft.urgent,
      enabled: true,
    });
  };

  return (
    <section className="card p-4" aria-label="Nouvelle routine">
      <form onSubmit={submitText} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
          <Field label="Bot" htmlFor="nr-bot">
            <select
              id="nr-bot"
              className="select"
              value={botId}
              onChange={(e) => {
                setBotId(e.target.value);
                setChannelId('');
              }}
            >
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.avatar} {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ce que tu veux, quand tu le veux" htmlFor="nr-text">
            <textarea
              id="nr-text"
              data-autofocus
              className="textarea min-h-[64px]"
              placeholder={EXAMPLES[0]}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || !botId || parse.isPending}>
            {parse.isPending && <Spinner className="size-4 text-accent-fg" />}
            Interpréter
          </button>
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            Annuler
          </button>
          {parse.isPending && <span className="text-[12.5px] text-muted">Haiku interprète ta demande… cela peut prendre jusqu’à une minute.</span>}
        </div>
        {!draft && !parse.isPending && (
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="chip hover:text-fg" onClick={() => setText(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}
      </form>

      {error && (
        <div role="alert" className="mt-3 rounded-[4px] border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </div>
      )}

      {draft && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-[14px] font-semibold">Vérifie avant d’enregistrer</h3>
          <p className="mt-0.5 mb-3 text-[12.5px] text-muted">
            Lecture proposée : « {draft.description} ». Ajuste l’expression ou la consigne si besoin.
          </p>
          <RoutineEditor value={draft} onChange={(v) => setDraft({ ...draft, ...v })} />
          <div className="mt-4">
            <Field label="Où publier le résultat" htmlFor="nr-channel">
              <select id="nr-channel" className="select sm:w-80" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                <option value="">Conversation privée avec {bot?.name ?? 'le bot'}</option>
                {botChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirm}
              disabled={create.isPending || !draft.cron.trim() || !draft.instruction.trim()}
            >
              {create.isPending && <Spinner className="size-4 text-accent-fg" />}
              Créer la routine
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setDraft(null)}>
              Reformuler
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
