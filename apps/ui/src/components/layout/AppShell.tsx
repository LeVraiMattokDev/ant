import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { MobileTabBar } from './MobileTabBar';
import { PausedBanner } from './PausedBanner';
import { NewChannelModal } from '../chat/NewChannelModal';
import { cx } from '../ui';

interface ShellApi {
  openDrawer: () => void;
  openNewChannel: () => void;
}

const ShellContext = createContext<ShellApi>({ openDrawer: () => {}, openNewChannel: () => {} });

export const useShell = () => useContext(ShellContext);

export function AppShell({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const [newChannel, setNewChannel] = useState(false);
  const location = useLocation();
  const inConversation = location.pathname.startsWith('/c/');

  useEffect(() => setDrawer(false), [location.pathname]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  const openDrawer = useCallback(() => setDrawer(true), []);
  const openNewChannel = useCallback(() => {
    setDrawer(false);
    setNewChannel(true);
  }, []);
  const api = useMemo(() => ({ openDrawer, openNewChannel }), [openDrawer, openNewChannel]);

  return (
    <ShellContext.Provider value={api}>
      <div className="flex h-full overflow-hidden">
        <aside className="hidden w-[248px] shrink-0 border-r border-line bg-surface md:flex md:flex-col">
          <Sidebar />
        </aside>

        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="absolute inset-0 bg-black/55" onClick={() => setDrawer(false)} />
            <aside className="safe-top absolute inset-y-0 left-0 flex w-[84%] max-w-[300px] flex-col border-r border-line bg-surface shadow-pop">
              <Sidebar onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}

        <div className={cx('safe-top flex min-w-0 flex-1 flex-col', !inConversation && 'pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0')}>
          <PausedBanner />
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        </div>
      </div>
      {!inConversation && <MobileTabBar />}
      <NewChannelModal open={newChannel} onClose={() => setNewChannel(false)} />
    </ShellContext.Provider>
  );
}
