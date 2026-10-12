import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Plus, Trash2 } from 'lucide-react';
import type { RoutineDTO, RoutineInput } from '@ant/shared';
import { del, errorMessage, patch, post } from '../lib/api';
import { qk, useBotMap, useBots, useChannels, useRoutines } from '../lib/queries';
import { formatFull, formatRelative, formatShort } from '../lib/format';
import { toast } from '../lib/toast';
import { Modal, useConfirm } from '../components/Modal';
import { NewRoutine } from '../components/routines/NewRoutine';
import { RoutineEditor, type RoutineFields } from '../components/routines/RoutineEditor';
import { Avatar, Badge, EmptyState, ErrorBlock, LoadingBlock, PageHeader, Spinner, Toggle, cx } from '../components/ui';

/** Bots propose routines disabled; one that never ran and is disabled is treated as a proposal. */
const isProposal = (r: RoutineDTO) => !r.enabled && !r.lastRunAt;

function useRoutineMutations() {
  const qc = useQueryClient();
  const replace = (r: RoutineDTO) => qc.setQueryData<RoutineDTO[]>(qk.routines, (d) => d?.map((x) => (x.id === r.id ? r : x)));
  return {
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: Partial<RoutineInput> }) => patch<RoutineDTO>(`/api/routines/${id}`, input),
      onSuccess: replace,
      onError: (err) => toast.fromError(err, 'Routine non modifiée'),
    }),
    run: useMutation({
      mutationFn: (id: string) => post(`/api/routines/${id}/run`),
      onSuccess: () => toast.info('Routine lancée', 'Le résultat arrivera dans la conversation.'),
      onError: (err) => toast.fromError(err, 'Lancement impossible'),
    }),
    remove: useMutation({
      mutationFn: (id: string) => del(`/api/routines/${id}`),
      onSuccess: (_d, id) => qc.setQueryData<RoutineDTO[]>(qk.routines, (d) => d?.filter((x) => x.id !== id)),
      onError: (err) => toast.fromError(err, 'Suppression impossible'),
    }),
  };
}

function EditRoutineModal({ routine, onClose }: { routine: RoutineDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<RoutineFields>({
    cron: routine.cron,
    timezone: routine.timezone,
    instruction: routine.instruction,
    urgent: routine.urgent,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      patch<RoutineDTO>(`/api/routines/${routine.id}`, {
        cron: value.cron.trim(),
        timezone: value.timezone.trim() || undefined,
        instruction: value.instruction.trim(),
        urgent: value.urgent,
      }),
    onSuccess: (r) => {
      qc.setQueryData<RoutineDTO[]>(qk.routines, (d) => d?.map((x) => (x.id === r.id ? r : x)));
      toast.success('Routine modifiée');
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Modifier la routine"
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="button" className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending || !value.instruction.trim()}>
            {save.isPending && <Spinner className="size-4 text-accent-fg" />}
            Enregistrer
          </button>
        </>
      }
    >
      {error && <div className="mb-3 text-[13px] text-danger">{error}</div>}
      <p className="mb-3 text-[12.5px] text-muted">Demande d’origine : « {routine.sourceText} »</p>
      <RoutineEditor value={value} onChange={setValue} />
    </Modal>
  );
}

function RoutineRow({ routine, onEdit }: { routine: RoutineDTO; onEdit: () => void }) {
  const bots = useBotMap();
  const channels = useChannels();
  const confirm = useConfirm();
  const { update, run, remove } = useRoutineMutations();
  const bot = bots.get(routine.botId);
  const channel = channels.data?.find((c) => c.id === routine.channelId);
  const proposal = isProposal(routine);

  const onDelete = async () => {
    const ok = await confirm({
      title: 'Supprimer cette routine ?',
      body: `« ${routine.description} » ne s’exécutera plus. Cette action est définitive.`,
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (ok) remove.mutate(routine.id);
  };

  return (
    <li className={cx('card p-3.5', proposal && 'border-accent/60 bg-accent-soft/30')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {proposal ? (
              <Badge tone="accent">Proposée — à activer</Badge>
            ) : routine.enabled ? (
              <Badge tone="success">Active</Badge>
            ) : (
              <Badge>Désactivée</Badge>
            )}
            {routine.urgent && <Badge tone="danger">Urgente</Badge>}
          </div>
          <h3 className="mt-1.5 text-[14.5px] font-semibold">{routine.description}</h3>
          <p className="mt-0.5 text-[13px] text-muted">{routine.instruction}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-subtle">
            {bot && (
              <Link to={`/bots/${bot.id}`} className="flex items-center gap-1 hover:text-fg">
                <Avatar emoji={bot.avatar} size="sm" />
                {bot.name}
              </Link>
            )}
            {channel && (
              <Link to={`/c/${channel.id}`} className="hover:text-fg">
                {channel.kind === 'group' ? `#${channel.name}` : 'conversation privée'}
              </Link>
            )}
            <span className="mono">{routine.cron}</span>
            <span>{routine.timezone}</span>
            <span>dernière : {routine.lastRunAt ? formatShort(routine.lastRunAt) : 'jamais'}</span>
          </div>
          {routine.enabled && routine.nextRuns.length > 0 && (
            <div className="mt-1.5 text-[12px] text-muted">
              Prochaines :{' '}
              {routine.nextRuns.slice(0, 3).map((r, i) => (
                <span key={r} title={formatFull(r)}>
                  {i > 0 && ' · '}
                  {formatShort(r)}
                  {i === 0 && <span className="text-subtle"> ({formatRelative(r)})</span>}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="w-full sm:w-auto">
          <Toggle
            label={routine.enabled ? 'Activée' : 'Activer'}
            checked={routine.enabled}
            disabled={update.isPending}
            onChange={(v) => update.mutate({ id: routine.id, input: { enabled: v } })}
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
        <button type="button" className="btn btn-sm" onClick={() => run.mutate(routine.id)} disabled={run.isPending}>
          {run.isPending ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
          Exécuter maintenant
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>
          Modifier
        </button>
        <button type="button" className="btn btn-ghost btn-sm ml-auto text-danger" onClick={() => void onDelete()} disabled={remove.isPending}>
          <Trash2 className="size-3.5" />
          Supprimer
        </button>
      </div>
    </li>
  );
}

export function RoutinesPage() {
  const routines = useRoutines();
  const bots = useBots();
  const channels = useChannels();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RoutineDTO | null>(null);

  const sorted = [...(routines.data ?? [])].sort((a, b) => {
    const pa = isProposal(a) ? 0 : a.enabled ? 1 : 2;
    const pb = isProposal(b) ? 0 : b.enabled ? 1 : 2;
    if (pa !== pb) return pa - pb;
    return (a.nextRuns[0] ?? '9999').localeCompare(b.nextRuns[0] ?? '9999');
  });

  return (
    <>
      <PageHeader
        title="Routines"
        description="Des tâches planifiées, décrites en langage naturel."
        actions={
          !creating && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} disabled={!bots.data?.length}>
              <Plus className="size-4" />
              Nouvelle routine
            </button>
          )
        }
      />
      <div className="scroll-y flex-1 p-4 md:p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {creating && bots.data && (
            <NewRoutine bots={bots.data} channels={channels.data ?? []} onDone={() => setCreating(false)} />
          )}
          {routines.isPending ? (
            <LoadingBlock />
          ) : routines.isError ? (
            <ErrorBlock error={routines.error} onRetry={() => void routines.refetch()} />
          ) : sorted.length === 0 ? (
            !creating && (
              <EmptyState
                title="Aucune routine"
                action={
                  <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} disabled={!bots.data?.length}>
                    Créer une routine
                  </button>
                }
              >
                Exemple : « chaque lundi à 8h, fais-moi un point sur mes projets ». Les bots peuvent aussi en proposer.
              </EmptyState>
            )
          ) : (
            <ul className="space-y-3">
              {sorted.map((r) => (
                <RoutineRow key={r.id} routine={r} onEdit={() => setEditing(r)} />
              ))}
            </ul>
          )}
        </div>
      </div>
      {editing && <EditRoutineModal routine={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
