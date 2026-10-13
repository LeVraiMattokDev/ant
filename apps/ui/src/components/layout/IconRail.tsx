import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { ComponentType } from 'react';
import { Brain, ClipboardCheck, Gauge, Home, LogOut, Monitor, Moon, Plus, ScrollText, Search, Settings, Sun } from 'lucide-react';
import { FeatureBoundary, FeatureRailActions, featureNav, type FeatureNavItem } from '../../features';
import { usePendingApprovals } from '../../lib/queries';
import { useTheme } from '../../lib/theme';
import { useWsStatus } from '../../lib/ws';
import { OwnerAvatar } from '../BotAvatar';
import { MenuItem, MenuSeparator, Popover } from '../Popover';
import { cx } from '../ui';
import { CreateMenu } from './CreateMenu';
import { useLogout } from './useLogout';
import { WorkspaceMark } from './WorkspaceMark';

interface RailItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  badge?: number;
  /** Extra paths that also light this item up. */
  also?: string[];
}

const railBtn = 'tip flex size-10 items-center justify-center rounded-[12px] text-muted transition-colors hover:bg-hover hover:text-fg';

function RailLink({ item }: { item: RailItem }) {
  const { pathname } = useLocation();
  const active = item.to === '/' ? pathname === '/' || (item.also ?? []).includes(pathname) : pathname.startsWith(item.to);
  const label = item.badge ? `${item.label} (${item.badge} en attente)` : item.label;
  return (
    <Link to={item.to} data-tip={item.label} aria-label={label} aria-current={active ? 'page' : undefined} className={cx(railBtn, active && 'bg-active text-fg')}>
      <item.icon className="size-[19px]" />
      {item.badge ? (
        <span className="absolute -top-0.5 -right-0.5 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-accent-fg ring-2 ring-rail">
          {item.badge > 99 ? '99+' : item.badge}
        </span>
      ) : null}
    </Link>
  );
}

/** A feature module's rail entry: its badge hook runs in this component. */
function FeatureRailLink({ item }: { item: FeatureNavItem }) {
  const badge = item.useBadge?.() ?? 0;
  return <RailLink item={{ to: item.to, label: item.label, icon: item.icon, badge }} />;
}

function OwnerMenu() {
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const logout = useLogout();
  const ws = useWsStatus();
  const wsLabel = ws === 'open' ? 'Temps réel connecté' : ws === 'connecting' ? 'Connexion au temps réel…' : 'Temps réel déconnecté, reconnexion…';
  return (
    <Popover
      label="Mon compte"
      placement="right-end"
      trigger={(p) => (
        <button type="button" {...p} className="tip relative rounded-full" data-tip={`Toi · ${wsLabel}`} aria-label={`Mon compte (${wsLabel})`}>
          <OwnerAvatar size={34} />
          <span
            className={cx(
              'absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-rail',
              ws === 'open' ? 'bg-success' : ws === 'connecting' ? 'bg-warning' : 'bg-danger',
            )}
          />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <OwnerAvatar size={30} />
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold">Toi</div>
              <div className="text-[12px] text-subtle">{wsLabel}</div>
            </div>
          </div>
          <MenuSeparator />
          <MenuItem
            icon={<Settings />}
            onSelect={() => {
              close();
              navigate('/settings');
            }}
          >
            Réglages
          </MenuItem>
          <MenuItem
            icon={theme === 'dark' ? <Sun /> : <Moon />}
            onSelect={() => {
              close();
              setTheme(theme === 'dark' ? 'light' : 'dark');
            }}
          >
            {theme === 'dark' ? 'Thème clair' : 'Thème sombre'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<LogOut />}
            onSelect={() => {
              close();
              logout.mutate();
            }}
          >
            Se déconnecter
          </MenuItem>
        </>
      )}
    </Popover>
  );
}

/** Far-left icon navigation (desktop). */
export function IconRail() {
  const { data: pending } = usePendingApprovals();
  const items: RailItem[] = [
    { to: '/', label: 'Accueil', icon: Home, also: ['/accueil'] },
    { to: '/search', label: 'Recherche', icon: Search },
    { to: '/approvals', label: 'Validations', icon: ClipboardCheck, badge: pending?.length ?? 0 },
    { to: '/computer', label: 'Ordinateur', icon: Monitor },
    { to: '/memory', label: 'Mémoire', icon: Brain },
    { to: '/quota', label: 'Quota & budget', icon: Gauge },
    { to: '/audit', label: 'Journal d’audit', icon: ScrollText },
  ];
  const { pathname } = useLocation();
  return (
    <nav aria-label="Navigation principale" className="flex w-[60px] shrink-0 flex-col items-center gap-1 bg-rail py-3">
      <Link to="/" aria-label="Ant, accueil" className="tip mb-2 rounded-[12px]" data-tip="Ant">
        <WorkspaceMark size={36} />
      </Link>
      <CreateMenu
        placement="right-start"
        trigger={(p) => (
          <button type="button" {...p} className={cx(railBtn, 'mb-2 border border-line-strong')} data-tip="Créer" aria-label="Créer">
            <Plus className="size-[18px]" />
          </button>
        )}
      />
      {items.map((it) => (
        <RailLink key={it.to} item={it} />
      ))}
      {featureNav('rail').map((it) => (
        // A badge hook that throws only loses its badge: the entry and the rail stay.
        <FeatureBoundary key={it.to} module={it.to} slot="nav" fallback={<RailLink item={{ to: it.to, label: it.label, icon: it.icon }} />}>
          <FeatureRailLink item={it} />
        </FeatureBoundary>
      ))}
      <div className="mt-auto flex flex-col items-center gap-2">
        <FeatureRailActions />
        <Link
          to="/settings"
          data-tip="Réglages"
          aria-label="Réglages"
          aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
          className={cx(railBtn, pathname.startsWith('/settings') && 'bg-active text-fg')}
        >
          <Settings className="size-[19px]" />
        </Link>
        <OwnerMenu />
      </div>
    </nav>
  );
}
