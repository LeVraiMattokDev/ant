import { matchPath, NavLink, useLocation } from 'react-router-dom';
import {
  Bot,
  CalendarClock,
  ClipboardCheck,
  Gauge,
  Home,
  Monitor,
  Brain,
  Plus,
  ScrollText,
  Search,
  Settings,
  Hash,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useBots, useChannels, usePendingApprovals } from '../../lib/queries';
import { useWsStatus } from '../../lib/ws';
import { isUnread, useReadMarks } from '../../lib/unread';
import { Avatar, CountBadge, cx } from '../ui';
import { useShell } from './AppShell';
import { BrandMark } from './BrandMark';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  badge?: number;
  end?: boolean;
}

function navClass({ isActive }: { isActive: boolean }): string {
  return cx(
    'flex h-[30px] items-center gap-2.5 rounded-[4px] px-2 text-[13.5px]',
    isActive ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg',
  );
}

function WsIndicator() {
  const status = useWsStatus();
  const label =
    status === 'open' ? 'Temps réel connecté' : status === 'connecting' ? 'Connexion au temps réel…' : 'Temps réel déconnecté, reconnexion…';
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-subtle" title={label} aria-label={label} role="status">
      <span className={cx('size-1.5 rounded-full', status === 'open' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-danger')} />
      {status !== 'open' && <span>{status === 'connecting' ? 'Connexion…' : 'Hors ligne'}</span>}
    </span>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data: bots } = useBots();
  const { data: channels } = useChannels();
  const { data: pending } = usePendingApprovals();
  const marks = useReadMarks();
  const { pathname } = useLocation();
  const channelId = matchPath('/c/:channelId/*', pathname)?.params.channelId;
  const { openNewChannel } = useShell();

  const nav: NavItem[] = [
    { to: '/', label: 'Accueil', icon: Home, end: true },
    { to: '/search', label: 'Recherche', icon: Search },
    { to: '/approvals', label: 'Validations', icon: ClipboardCheck, badge: pending?.length ?? 0 },
    { to: '/computer', label: 'Ordinateur', icon: Monitor },
    { to: '/routines', label: 'Routines', icon: CalendarClock },
    { to: '/memory', label: 'Mémoire', icon: Brain },
    { to: '/bots', label: 'Bots', icon: Bot },
    { to: '/quota', label: 'Quota & budget', icon: Gauge },
    { to: '/audit', label: 'Journal d’audit', icon: ScrollText },
    { to: '/settings', label: 'Réglages', icon: Settings },
  ];

  const botById = new Map((bots ?? []).map((b) => [b.id, b]));
  const groups = (channels ?? []).filter((c) => c.kind === 'group').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const dms = (channels ?? [])
    .filter((c) => c.kind === 'dm' && c.dmBotId && botById.has(c.dmBotId))
    .sort((a, b) => (botById.get(a.dmBotId!)?.name ?? '').localeCompare(botById.get(b.dmBotId!)?.name ?? '', 'fr'));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between px-3">
        <NavLink to="/" onClick={onNavigate} className="flex items-center gap-2 font-semibold tracking-[-0.01em]">
          <BrandMark className="size-5" />
          Ant
        </NavLink>
        <WsIndicator />
      </div>

      <nav aria-label="Navigation principale" className="scroll-y flex-1 px-2 pb-3">
        <ul className="space-y-px">
          {nav.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className={navClass} onClick={onNavigate}>
                <item.icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.badge ? <CountBadge count={item.badge} label={`${item.badge} validations en attente`} /> : null}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex items-center justify-between px-2">
          <span className="section-title">Canaux</span>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Nouveau canal" title="Nouveau canal" onClick={openNewChannel}>
            <Plus className="size-3.5" />
          </button>
        </div>
        <ul className="mt-1 space-y-px">
          {groups.map((c) => {
            const unread = c.id !== channelId && isUnread(c.lastMessageAt, c.id, marks);
            return (
              <li key={c.id}>
                <NavLink to={`/c/${c.id}`} className={navClass} onClick={onNavigate}>
                  <Hash className="size-3.5 shrink-0 text-subtle" />
                  <span className={cx('truncate', unread && 'font-semibold text-fg')}>{c.name}</span>
                  {unread && <span className="ml-auto size-1.5 rounded-full bg-accent" aria-label="Non lu" />}
                </NavLink>
              </li>
            );
          })}
          {groups.length === 0 && (
            <li>
              <button type="button" onClick={openNewChannel} className="px-2 py-1 text-left text-[12.5px] text-subtle hover:text-fg">
                Créer un canal de groupe
              </button>
            </li>
          )}
        </ul>

        <div className="mt-5 px-2">
          <span className="section-title">Messages privés</span>
        </div>
        <ul className="mt-1 space-y-px">
          {dms.map((c) => {
            const bot = botById.get(c.dmBotId!)!;
            const unread = c.id !== channelId && isUnread(c.lastMessageAt, c.id, marks);
            return (
              <li key={c.id}>
                <NavLink to={`/c/${c.id}`} className={navClass} onClick={onNavigate} title={bot.activity ?? bot.role}>
                  <span className="relative">
                    <Avatar emoji={bot.avatar} size="sm" />
                    {bot.activity && (
                      <span className="absolute -right-0.5 -bottom-0.5 size-2 animate-pulse rounded-full border border-surface bg-accent" />
                    )}
                  </span>
                  <span className={cx('truncate', unread && 'font-semibold text-fg', bot.paused && 'opacity-60')}>{bot.name}</span>
                  {bot.paused && <span className="text-[11px] text-subtle">pause</span>}
                  {unread && <span className="ml-auto size-1.5 rounded-full bg-accent" aria-label="Non lu" />}
                </NavLink>
              </li>
            );
          })}
          {dms.length === 0 && (
            <li>
              <NavLink to="/bots/new" onClick={onNavigate} className="block px-2 py-1 text-[12.5px] text-subtle hover:text-fg">
                Créer ton premier bot
              </NavLink>
            </li>
          )}
        </ul>
      </nav>
    </div>
  );
}
