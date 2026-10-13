import { useMemo, useRef, useState } from 'react';
import { Link, NavLink, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, CalendarClock, MessagesSquare, Plus, Search, Settings2, Users, X } from 'lucide-react';
import type { BotDTO, ChannelDTO, RoutineDTO } from '@ant/shared';
import { patch } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { useNow, useStoredState } from '../../lib/hooks';
import { botLiveState, formatListTime, matchesQuery, previewText } from '../../lib/preview';
import { qk, useActiveRuns, useBots, useChannels, useRoutines, useWorkerDown } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { isUnread, useReadMarks } from '../../lib/unread';
import { BotAvatar, GroupAvatar } from '../BotAvatar';
import { Spinner, Switch, Tabs, cx } from '../ui';
import { CreateMenu } from './CreateMenu';
import { useShell } from './shell';
import { WorkspaceMark } from './WorkspaceMark';

type ListTab = 'agents' | 'routines';
const LIST_TABS = ['agents', 'routines'] as const;

function TeamTile({ channel, members, unread }: { channel: ChannelDTO; members: BotDTO[]; unread: boolean }) {
  return (
    <li>
      <NavLink
        to={`/c/${channel.id}`}
        title={channel.topic || channel.name}
        className={({ isActive }) =>
          cx('flex w-[78px] flex-col items-center gap-1.5 rounded-[14px] px-1 pt-2.5 pb-2 transition-colors', isActive ? 'bg-active' : 'hover:bg-hover')
        }
      >
        <span className="relative flex size-11 items-center justify-center">
          <GroupAvatar bots={members} size={44} />
          {unread && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-accent ring-2 ring-surface" aria-label="Non lu" />}
        </span>
        <span className={cx('w-full truncate text-center text-[12.5px] leading-tight', unread ? 'font-semibold text-fg' : 'font-medium text-fg/90')}>
          {channel.name}
        </span>
      </NavLink>
    </li>
  );
}

function BotRow({
  bot,
  channel,
  bots,
  unread,
  live,
}: {
  bot: BotDTO;
  channel: ChannelDTO | undefined;
  bots: Map<string, BotDTO>;
  unread: boolean;
  live: ReturnType<typeof botLiveState>;
}) {
  const time = formatListTime(channel?.lastMessage?.createdAt ?? channel?.lastMessageAt);
  const preview = channel ? previewText(channel, bots) : 'Aucun message pour le moment';
  return (
    <li>
      <NavLink
        to={`/c/${channel?.id ?? bot.dmChannelId}`}
        className={({ isActive }) =>
          // `group`: on the selected row (aria-current, bg-active), small grey text is raised one step to keep 4.5:1.
          cx('group flex items-center gap-3 rounded-[14px] px-2.5 py-2.5 transition-colors', isActive ? 'bg-active' : 'hover:bg-hover')
        }
      >
        <span className={cx('relative', bot.paused && 'opacity-55')}>
          <BotAvatar bot={bot} size={40} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cx('max-w-[60%] shrink-0 truncate text-[14px] font-semibold', bot.paused && 'text-muted')}>{bot.name}</span>
            {bot.paused ? (
              <span className="shrink-0 rounded-[6px] bg-warning-soft px-1.5 text-[11px] leading-[18px] font-medium text-warning">En pause</span>
            ) : (
              bot.role && (
                <span
                  className="min-w-0 truncate rounded-[6px] bg-active px-1.5 text-[11.5px] leading-[18px] text-muted group-aria-[current=page]:text-fg"
                  title={bot.role}
                >
                  {bot.role}
                </span>
              )
            )}
            <span className={cx('ml-auto shrink-0 pl-1 text-[11.5px]', unread ? 'font-medium text-accent-text' : 'text-subtle group-aria-[current=page]:text-muted')}>{time}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            {live ? (
              <span className={cx('min-w-0 truncate text-[13px] font-medium', live.tone === 'working' ? 'live-text' : 'text-warning')}>{live.label}</span>
            ) : (
              <span className={cx('min-w-0 truncate text-[13px]', unread ? 'text-fg' : 'text-muted')}>{preview}</span>
            )}
            {unread && <span className="ml-auto size-2 shrink-0 rounded-full bg-accent" aria-label="Non lu" />}
          </span>
        </span>
      </NavLink>
    </li>
  );
}

function AgentsTab({ query }: { query: string }) {
  const { data: bots, isPending: botsPending } = useBots();
  const { data: channels } = useChannels();
  const { data: runs } = useActiveRuns();
  // A queued run of a stopped worker waits for it, not for a free slot.
  const workerDown = useWorkerDown();
  const marks = useReadMarks();
  const { openNewChannel } = useShell();
  const { pathname } = useLocation();
  const current = matchPath('/c/:channelId/*', pathname)?.params.channelId;
  useNow(60_000);

  const botMap = useMemo(() => new Map((bots ?? []).map((b) => [b.id, b])), [bots]);
  const dmByBot = useMemo(() => new Map((channels ?? []).filter((c) => c.kind === 'dm' && c.dmBotId).map((c) => [c.dmBotId!, c])), [channels]);
  const groups = (channels ?? [])
    .filter((c) => c.kind === 'group' && matchesQuery(query, c.name, c.topic))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
  const list = [...(bots ?? [])]
    .filter((b) => matchesQuery(query, b.name, b.role, b.slug))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (botsPending) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      {(groups.length > 0 || !query) && (
        <ul aria-label="Équipes" className="flex gap-1 overflow-x-auto px-2 pt-1 pb-2 [scrollbar-width:none]">
          {groups.map((c) => (
            <TeamTile
              key={c.id}
              channel={c}
              members={c.botIds.map((id) => botMap.get(id)).filter((b): b is BotDTO => !!b)}
              unread={c.id !== current && isUnread(c.lastMessageAt, c.id, marks)}
            />
          ))}
          {!query && (
            <li>
              <button
                type="button"
                onClick={openNewChannel}
                className="flex w-[78px] flex-col items-center gap-1.5 rounded-[14px] px-1 pt-2.5 pb-2 text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                <span className="flex size-11 items-center justify-center rounded-full border border-dashed border-line-strong">
                  <Users className="size-[18px]" />
                </span>
                <span className="text-[12.5px] leading-tight font-medium">{groups.length ? 'Nouvelle équipe' : 'Créer une équipe'}</span>
              </button>
            </li>
          )}
        </ul>
      )}

      <div className="flex items-center justify-between px-3.5 pt-1 pb-1">
        <span className="text-[12px] font-medium text-subtle">
          Bots{bots && bots.length > 0 ? ` · ${bots.length}` : ''}
        </span>
        <span className="flex items-center gap-0.5">
          <Link to="/bots" className="btn btn-ghost btn-sm btn-icon" aria-label="Gérer les bots" title="Gérer les bots">
            <Settings2 className="size-3.5" />
          </Link>
          <Link to="/bots/new" className="btn btn-ghost btn-sm btn-icon" aria-label="Nouveau bot" title="Nouveau bot">
            <Plus className="size-4" />
          </Link>
        </span>
      </div>

      {list.length === 0 ? (
        query ? (
          <p className="px-4 py-6 text-center text-[13px] text-subtle">
            Aucun bot ne correspond. <kbd className="kbd">Entrée</kbd> pour chercher dans les messages.
          </p>
        ) : (
          <div className="mx-2 rounded-[14px] border border-dashed border-line-strong px-4 py-6 text-center">
            <Bot className="mx-auto size-5 text-subtle" />
            <p className="mt-2 text-[13px] text-muted">Aucun bot pour l’instant.</p>
            <Link to="/bots/new" className="btn btn-primary btn-sm mt-3">
              Créer ton premier bot
            </Link>
          </div>
        )
      ) : (
        <ul aria-label="Bots" className="space-y-0.5 px-2 pb-3">
          {list.map((b) => {
            const channel = dmByBot.get(b.id);
            const channelId = channel?.id ?? b.dmChannelId;
            return (
              <BotRow
                key={b.id}
                bot={b}
                channel={channel}
                bots={botMap}
                unread={channelId !== current && isUnread(channel?.lastMessageAt ?? null, channelId, marks)}
                live={botLiveState(b, runs, channelId, workerDown)}
              />
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Same rule as the Routines page: a bot's proposal, flagged by the server until the owner enables it. */
const isProposal = (r: RoutineDTO) => !r.enabled && r.proposed;

function RoutineItem({ routine, bot }: { routine: RoutineDTO; bot: BotDTO | undefined }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch<RoutineDTO>(`/api/routines/${routine.id}`, { enabled }),
    onMutate: (enabled) => {
      // Enabling accepts a proposal: it is no longer one, even if disabled again later.
      qc.setQueryData<RoutineDTO[]>(qk.routines, (d) => d?.map((x) => (x.id === routine.id ? { ...x, enabled, ...(enabled ? { proposed: false } : {}) } : x)));
    },
    onSuccess: (r) => qc.setQueryData<RoutineDTO[]>(qk.routines, (d) => d?.map((x) => (x.id === r.id ? r : x))),
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: qk.routines });
      toast.fromError(err, 'Routine non modifiée');
    },
  });
  const next = routine.enabled ? routine.nextRuns[0] : undefined;
  const status = isProposal(routine) ? 'Proposée, à activer' : !routine.enabled ? 'Désactivée' : next ? `Prochaine ${formatRelative(next)}` : 'Aucune exécution prévue';
  return (
    <li className="group flex items-start gap-3 rounded-[14px] px-2.5 py-2.5 transition-colors hover:bg-hover">
      <BotAvatar bot={bot} size={32} className="mt-0.5" />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate(`/routines?id=${routine.id}`)} title={routine.sourceText}>
        <span className="block truncate text-[13.5px] leading-snug font-medium">{routine.description}</span>
        <span className="block truncate text-[12.5px] text-muted">{routine.instruction}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-subtle">
          <span className="shrink-0">{bot?.name ?? 'Bot archivé'}</span>
          <span aria-hidden="true">·</span>
          <span className={cx('truncate', isProposal(routine) && 'text-accent-text')}>{status}</span>
        </span>
      </button>
      <span className="mt-1">
        <Switch
          checked={routine.enabled}
          disabled={toggle.isPending}
          label={routine.enabled ? `Désactiver « ${routine.description} »` : `Activer « ${routine.description} »`}
          onChange={(v) => toggle.mutate(v)}
        />
      </span>
    </li>
  );
}

function RoutinesTab({ query }: { query: string }) {
  const routines = useRoutines();
  const { data: bots } = useBots();
  useNow(60_000);
  const botMap = new Map((bots ?? []).map((b) => [b.id, b]));
  const list = [...(routines.data ?? [])]
    .filter((r) => matchesQuery(query, r.description, r.instruction, botMap.get(r.botId)?.name))
    .sort((a, b) => {
      const pa = isProposal(a) ? 0 : a.enabled ? 1 : 2;
      const pb = isProposal(b) ? 0 : b.enabled ? 1 : 2;
      return pa - pb || (a.nextRuns[0] ?? '9999').localeCompare(b.nextRuns[0] ?? '9999');
    });

  return (
    <div className="px-2 pb-3">
      <div className="flex items-center justify-between px-1.5 pt-1 pb-2">
        <Link to="/routines?new=1" className="btn btn-sm">
          <Plus className="size-3.5" />
          Nouvelle routine
        </Link>
        <Link to="/routines" className="text-[12.5px] text-muted hover:text-fg">
          Tout gérer
        </Link>
      </div>
      {routines.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <div className="mx-0.5 rounded-[14px] border border-dashed border-line-strong px-4 py-6 text-center">
          <CalendarClock className="mx-auto size-5 text-subtle" />
          <p className="mt-2 text-[13px] text-muted">
            {query ? 'Aucune routine ne correspond.' : 'Aucune routine. Exemple : « chaque lundi à 8h, fais-moi un point sur mes projets ».'}
          </p>
        </div>
      ) : (
        <ul aria-label="Routines" className="space-y-0.5">
          {list.map((r) => (
            <RoutineItem key={r.id} routine={r} bot={botMap.get(r.botId)} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Search + "Conversations | Routines": the desktop sidebar panel, and the mobile home screen. */
export function ConversationList({ variant }: { variant: 'sidebar' | 'page' }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useStoredState<ListTab>('ant-list-tab', 'agents', LIST_TABS);
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {variant === 'page' && (
        <header className="flex items-center gap-2.5 px-4 pt-3 pb-2">
          <WorkspaceMark size={30} />
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Ant</h1>
          <span className="ml-auto">
            <CreateMenu
              placement="bottom-end"
              trigger={(p) => (
                <button type="button" {...p} className="btn btn-icon btn-round" aria-label="Créer">
                  <Plus className="size-[18px]" />
                </button>
              )}
            />
          </span>
        </header>
      )}
      <div className={cx('space-y-2.5 px-3', variant === 'sidebar' ? 'pt-3 pb-2' : 'pb-2')}>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = query.trim();
            if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <input
            ref={input}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            className="input h-[38px] border-line bg-[var(--ant-hover)] pr-8 pl-9"
            placeholder="Rechercher"
            aria-label="Rechercher (Entrée : chercher dans les messages)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-subtle hover:bg-hover hover:text-fg"
              aria-label="Effacer la recherche"
              onClick={() => {
                setQuery('');
                input.current?.focus();
              }}
            >
              <X className="size-3.5" />
            </button>
          )}
        </form>
        <Tabs<ListTab>
          label="Liste"
          className="flex w-full"
          value={tab}
          onChange={setTab}
          tabs={[
            {
              id: 'agents',
              label: (
                <>
                  <MessagesSquare className="size-3.5" />
                  Conversations
                </>
              ),
            },
            {
              id: 'routines',
              label: (
                <>
                  <CalendarClock className="size-3.5" />
                  Routines
                </>
              ),
            },
          ]}
        />
      </div>
      <nav aria-label={tab === 'agents' ? 'Conversations' : 'Routines'} className="scroll-y min-h-0 flex-1 pt-1">
        {tab === 'agents' ? <AgentsTab query={query} /> : <RoutinesTab query={query} />}
      </nav>
    </div>
  );
}
