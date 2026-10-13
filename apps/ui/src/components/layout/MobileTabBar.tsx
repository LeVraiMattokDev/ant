import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { ComponentType } from 'react';
import {
  Bot,
  Brain,
  CalendarClock,
  ClipboardCheck,
  Gauge,
  Home,
  LogOut,
  MessagesSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  ScrollText,
  Search,
  Settings,
  Sun,
  Users,
} from 'lucide-react';
import { usePendingApprovals } from '../../lib/queries';
import { useTheme } from '../../lib/theme';
import { MenuItem, MenuSeparator, Popover } from '../Popover';
import { cx } from '../ui';
import { useShell } from './shell';
import { useLogout } from './useLogout';

const tabClass = (active: boolean) =>
  cx('relative flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium', active ? 'text-fg' : 'text-subtle');

const MORE: { to: string; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { to: '/accueil', label: 'Accueil', icon: Home },
  { to: '/search', label: 'Recherche', icon: Search },
  { to: '/routines', label: 'Routines', icon: CalendarClock },
  { to: '/memory', label: 'Mémoire', icon: Brain },
  { to: '/bots', label: 'Bots', icon: Bot },
  { to: '/quota', label: 'Quota & budget', icon: Gauge },
  { to: '/audit', label: 'Journal d’audit', icon: ScrollText },
  { to: '/settings', label: 'Réglages', icon: Settings },
];

/** Bottom tab bar replacing the icon rail on phones. */
export function MobileTabBar() {
  const { data: pending } = usePendingApprovals();
  const count = pending?.length ?? 0;
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const logout = useLogout();
  const { openNewChannel } = useShell();
  const moreActive = MORE.some((m) => pathname.startsWith(m.to));

  return (
    <nav
      aria-label="Navigation mobile"
      className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex h-[calc(60px+env(safe-area-inset-bottom))] border-t border-line bg-surface/95 backdrop-blur md:hidden"
    >
      <NavLink to="/" end className={() => tabClass(pathname === '/')} aria-current={pathname === '/' ? 'page' : undefined}>
        <MessagesSquare className="size-[22px]" />
        Conversations
      </NavLink>
      <NavLink to="/approvals" className={({ isActive }) => tabClass(isActive)}>
        <span className="relative">
          <ClipboardCheck className="size-[22px]" />
          {count > 0 && (
            <span className="absolute -top-1 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-accent-fg">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </span>
        <span>
          Validations<span className="sr-only">{count ? ` (${count} en attente)` : ''}</span>
        </span>
      </NavLink>
      <NavLink to="/computer" className={({ isActive }) => tabClass(isActive)}>
        <Monitor className="size-[22px]" />
        Ordinateur
      </NavLink>
      <Popover
        label="Plus"
        placement="top-end"
        trigger={(p) => (
          <button type="button" {...p} className={tabClass(moreActive)}>
            <MoreHorizontal className="size-[22px]" />
            Plus
          </button>
        )}
      >
        {(close) => (
          <div className="w-[min(78vw,280px)]">
            {MORE.map((m) => (
              <MenuItem
                key={m.to}
                icon={<m.icon />}
                onSelect={() => {
                  close();
                  navigate(m.to);
                }}
              >
                {m.label}
              </MenuItem>
            ))}
            <MenuItem
              icon={<Users />}
              onSelect={() => {
                close();
                openNewChannel();
              }}
            >
              Nouvelle équipe
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={theme === 'dark' ? <Sun /> : <Moon />}
              onSelect={() => {
                close();
                setTheme(theme === 'dark' ? 'light' : 'dark');
              }}
            >
              {theme === 'dark' ? 'Thème clair' : 'Thème sombre'}
            </MenuItem>
            <MenuItem
              icon={<LogOut />}
              onSelect={() => {
                close();
                logout.mutate();
              }}
            >
              Se déconnecter
            </MenuItem>
          </div>
        )}
      </Popover>
    </nav>
  );
}
