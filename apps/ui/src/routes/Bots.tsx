import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { EFFORT_LABELS, MODEL_LABELS, type BotDTO } from '@ant/shared';
import { useBots } from '../lib/queries';
import { heartbeatLabel } from '../lib/format';
import { Badge, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui';
import { BotAvatar } from '../components/BotAvatar';

export function BotStatus({ bot }: { bot: BotDTO }) {
  if (bot.paused) return <Badge tone="warning">En pause</Badge>;
  if (bot.activity) return <Badge tone="accent">{bot.activity}</Badge>;
  return <Badge tone="neutral">Disponible</Badge>;
}

function BotCard({ bot }: { bot: BotDTO }) {
  return (
    <li className="card flex flex-col p-3.5">
      <div className="flex items-start gap-3">
        <BotAvatar bot={bot} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Link to={`/bots/${bot.id}`} className="truncate text-[15px] font-semibold hover:underline">
              {bot.name}
            </Link>
            <span className="text-[12px] text-subtle">@{bot.slug}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{bot.role}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        <BotStatus bot={bot} />
        <span className="chip">{MODEL_LABELS[bot.model] ?? bot.model}</span>
        <span className="chip">effort {EFFORT_LABELS[bot.effort]}</span>
        <span className="chip">{bot.heartbeatEnabled ? `heartbeat ${heartbeatLabel(bot.heartbeatIntervalMin)}` : 'heartbeat désactivé'}</span>
      </div>
      <div className="mt-3 flex gap-2 border-t border-line pt-3">
        <Link to={`/c/${bot.dmChannelId}`} className="btn btn-sm">
          Écrire
        </Link>
        <Link to={`/bots/${bot.id}`} className="btn btn-ghost btn-sm">
          Modifier
        </Link>
      </div>
    </li>
  );
}

export function BotsPage() {
  const bots = useBots();
  return (
    <>
      <PageHeader
        title="Bots"
        description="Chaque bot a son rôle, son modèle, ses permissions et son rythme de heartbeat."
        actions={
          <Link to="/bots/new" className="btn btn-primary">
            <Plus className="size-4" />
            Nouveau bot
          </Link>
        }
      />
      <div className="scroll-y flex-1 px-4 pb-8 md:px-8">
        {bots.isPending ? (
          <LoadingBlock />
        ) : bots.isError ? (
          <ErrorBlock error={bots.error} onRetry={() => void bots.refetch()} />
        ) : bots.data.length === 0 ? (
          <EmptyState
            title="Aucun bot"
            action={
              <Link to="/bots/new" className="btn btn-primary">
                Créer un bot
              </Link>
            }
          >
            Commence par un généraliste, puis ajoute des spécialistes (dev, recherche, écriture…).
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {bots.data.map((b) => (
              <BotCard key={b.id} bot={b} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
