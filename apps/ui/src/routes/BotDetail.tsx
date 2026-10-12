import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, HeartPulse, MessageSquare } from 'lucide-react';
import type { BotDTO, BotInput } from '@ant/shared';
import { del, errorMessage, patch, post } from '../lib/api';
import { qk, useBots } from '../lib/queries';
import { toast } from '../lib/toast';
import { BotForm } from '../components/bots/BotForm';
import { NudgesPanel, RunsPanel, TasksPanel } from '../components/bots/BotSidePanels';
import { useConfirm } from '../components/Modal';
import { Avatar, EmptyState, ErrorBlock, LoadingBlock, PageHeader, Spinner } from '../components/ui';
import { BotStatus } from './Bots';

export function BotDetailPage() {
  const { botId } = useParams();
  const isNew = !botId;
  const bots = useBots();
  const bot = bots.data?.find((b) => b.id === botId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: BotInput) => (isNew ? post<BotDTO>('/api/bots', input) : patch<BotDTO>(`/api/bots/${botId}`, input)),
    onSuccess: (b) => {
      qc.setQueryData<BotDTO[]>(qk.bots, (d) => (d ? (d.some((x) => x.id === b.id) ? d.map((x) => (x.id === b.id ? b : x)) : [...d, b]) : d));
      void qc.invalidateQueries({ queryKey: qk.bots });
      // A new bot gets its DM channel.
      if (isNew) void qc.invalidateQueries({ queryKey: qk.channels });
      setError(null);
      toast.success(isNew ? 'Bot créé' : 'Modifications enregistrées', b.name);
      if (isNew) navigate(`/bots/${b.id}`, { replace: true });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const heartbeat = useMutation({
    mutationFn: () => post(`/api/bots/${botId}/heartbeat`),
    onSuccess: () => toast.info('Heartbeat lancé', 'Les relances éventuelles arriveront dans sa conversation.'),
    onError: (err) => toast.fromError(err, 'Heartbeat impossible'),
  });

  const archive = useMutation({
    mutationFn: () => del(`/api/bots/${botId}`),
    onSuccess: () => {
      qc.setQueryData<BotDTO[]>(qk.bots, (d) => d?.filter((b) => b.id !== botId));
      void qc.invalidateQueries({ queryKey: qk.channels });
      toast.success('Bot archivé');
      navigate('/bots');
    },
    onError: (err) => toast.fromError(err, 'Archivage impossible'),
  });

  if (!isNew && bots.isPending) return <LoadingBlock />;
  if (!isNew && bots.isError) return <ErrorBlock error={bots.error} onRetry={() => void bots.refetch()} />;
  if (!isNew && !bot) {
    return (
      <EmptyState title="Bot introuvable" action={<Link to="/bots" className="btn">Retour aux bots</Link>}>
        Il a peut-être été archivé.
      </EmptyState>
    );
  }

  const onArchive = async () => {
    if (!bot) return;
    const ok = await confirm({
      title: `Archiver ${bot.name} ?`,
      body: 'Le bot arrête de travailler, ses routines sont désactivées et sa conversation disparaît de la liste. L’historique et le journal d’audit sont conservés.',
      confirmLabel: 'Archiver',
      danger: true,
    });
    if (ok) archive.mutate();
  };

  return (
    <>
      <PageHeader
        title={isNew ? 'Nouveau bot' : (bot?.name ?? '')}
        description={
          bot ? (
            <span className="inline-flex items-center gap-2">
              <span>@{bot.slug}</span>
              <BotStatus bot={bot} />
            </span>
          ) : (
            'Un bot = un rôle, un modèle, des permissions. Tu pourras tout modifier ensuite.'
          )
        }
        actions={
          <>
            <Link to="/bots" className="btn btn-ghost">
              <ArrowLeft className="size-4" />
              Bots
            </Link>
            {bot && (
              <>
                <Link to={`/c/${bot.dmChannelId}`} className="btn">
                  <MessageSquare className="size-4" />
                  Écrire
                </Link>
                <button type="button" className="btn" onClick={() => heartbeat.mutate()} disabled={heartbeat.isPending || bot.paused}>
                  {heartbeat.isPending ? <Spinner /> : <HeartPulse className="size-4" />}
                  Lancer un heartbeat maintenant
                </button>
              </>
            )}
          </>
        }
      />
      <div className="scroll-y flex-1 px-4 pt-5 md:px-6">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
          <div className="min-w-0 flex-1">
            {bot && (
              <div className="mb-5 flex items-center gap-3 md:hidden">
                <Avatar emoji={bot.avatar} size="lg" />
                <div className="text-[13px] text-muted">{bot.role}</div>
              </div>
            )}
            <BotForm key={bot?.id ?? 'new'} bot={bot} onSubmit={(input) => save.mutate(input)} saving={save.isPending} error={error} />
            {bot && (
              <section className="mt-6 mb-8 max-w-2xl rounded-[6px] border border-danger/40 p-4">
                <h2 className="text-[14px] font-semibold text-danger">Archiver ce bot</h2>
                <p className="mt-1 text-[13px] text-muted">L’archivage est définitif depuis l’interface ; l’historique reste consultable.</p>
                <button type="button" className="btn btn-danger mt-3" onClick={() => void onArchive()} disabled={archive.isPending}>
                  Archiver {bot.name}
                </button>
              </section>
            )}
          </div>
          {bot && (
            <aside className="flex w-full flex-col gap-4 pb-8 xl:sticky xl:top-5 xl:w-[420px] xl:shrink-0">
              <TasksPanel bot={bot} />
              <NudgesPanel bot={bot} />
              <RunsPanel bot={bot} />
            </aside>
          )}
        </div>
      </div>
    </>
  );
}
