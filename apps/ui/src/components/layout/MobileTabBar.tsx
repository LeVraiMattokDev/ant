import { NavLink } from 'react-router-dom';
import { ClipboardCheck, Home, Menu, Monitor, Search } from 'lucide-react';
import { usePendingApprovals } from '../../lib/queries';
import { cx } from '../ui';
import { useShell } from './AppShell';

const itemClass = ({ isActive }: { isActive: boolean }) =>
  cx('relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px]', isActive ? 'text-accent-text' : 'text-muted');

export function MobileTabBar() {
  const { openDrawer } = useShell();
  const { data: pending } = usePendingApprovals();
  const count = pending?.length ?? 0;
  return (
    <nav
      aria-label="Navigation mobile"
      className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex h-[calc(56px+env(safe-area-inset-bottom))] border-t border-line bg-surface md:hidden"
    >
      <button type="button" onClick={openDrawer} className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] text-muted">
        <Menu className="size-5" />
        Menu
      </button>
      <NavLink to="/" end className={itemClass}>
        <Home className="size-5" />
        Accueil
      </NavLink>
      <NavLink to="/approvals" className={itemClass}>
        <span className="relative">
          <ClipboardCheck className="size-5" />
          {count > 0 && (
            <span className="absolute -top-1 -right-2 rounded-full bg-accent px-1 text-[10px] font-semibold leading-[14px] text-accent-fg">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </span>
        Validations
      </NavLink>
      <NavLink to="/search" className={itemClass}>
        <Search className="size-5" />
        Recherche
      </NavLink>
      <NavLink to="/computer" className={itemClass}>
        <Monitor className="size-5" />
        Ordinateur
      </NavLink>
    </nav>
  );
}
