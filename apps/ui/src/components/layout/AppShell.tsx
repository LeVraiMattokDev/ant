import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FeatureBanners, FeatureEffects } from '../../features';
import { ErrorBoundary } from '../../lib/error-boundary';
import { DESKTOP_QUERY, useMediaQuery } from '../../lib/hooks';
import { NewChannelModal } from '../chat/NewChannelModal';
import { FilesDrawer } from '../computer/FilesDrawer';
import { cx } from '../ui';
import { ConnectionBanner } from './ConnectionBanner';
import { ConversationList } from './ConversationList';
import { IconRail } from './IconRail';
import { MobileTabBar } from './MobileTabBar';
import { PausedBanner } from './PausedBanner';
import { ShellContext, type ShellApi } from './shell';

// noVNC is heavy: the live panel is loaded on first use.
const ComputerPanel = lazy(() => import('../computer/ComputerPanel'));

export function AppShell({ children }: { children: ReactNode }) {
  const [newChannel, setNewChannel] = useState(false);
  const [files, setFiles] = useState(false);
  const [computer, setComputer] = useState(false);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const location = useLocation();
  const navigate = useNavigate();
  const inConversation = location.pathname.startsWith('/c/');
  const onComputerPage = location.pathname.startsWith('/computer');

  // The docked panel would duplicate the full computer page.
  useEffect(() => {
    if (onComputerPage || !desktop) setComputer(false);
  }, [onComputerPage, desktop]);

  const openNewChannel = useCallback(() => setNewChannel(true), []);
  const openFiles = useCallback(() => setFiles(true), []);
  const toggleComputer = useCallback(() => {
    if (!desktop) navigate('/computer');
    else setComputer((v) => !v);
  }, [desktop, navigate]);

  const api = useMemo<ShellApi>(
    () => ({ openNewChannel, openFiles, toggleComputer, computerOpen: computer }),
    [openNewChannel, openFiles, toggleComputer, computer],
  );

  return (
    <ShellContext.Provider value={api}>
      <div className="flex h-full overflow-hidden bg-bg md:bg-rail">
        <div className="hidden md:flex">
          <IconRail />
        </div>
        <div className="flex min-w-0 flex-1 overflow-hidden md:mt-2 md:rounded-tl-[18px] md:border-t md:border-l md:border-line md:bg-bg">
          <aside aria-label="Conversations et routines" className="hidden w-[272px] shrink-0 flex-col border-r border-line bg-surface md:flex xl:w-[300px]">
            <ConversationList variant="sidebar" />
          </aside>

          <div
            className={cx(
              'safe-top flex min-w-0 flex-1 flex-col md:pt-0',
              !inConversation && 'pb-[calc(60px+env(safe-area-inset-bottom))] md:pb-0',
            )}
          >
            <PausedBanner />
            <FeatureBanners />
            <ConnectionBanner />
            <main className="flex min-h-0 flex-1 flex-col">{children}</main>
          </div>

          {computer && (
            // A panel that fails to load (chunk gone after an update) or to render stays in its column: the shell
            // and the conversation remain usable.
            <ErrorBoundary label="Le panneau Ordinateur n’a pas pu s’afficher.">
              <Suspense fallback={null}>
                <ComputerPanel onClose={() => setComputer(false)} />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </div>
      {!inConversation && <MobileTabBar />}
      <NewChannelModal open={newChannel} onClose={() => setNewChannel(false)} />
      <FilesDrawer open={files} onClose={() => setFiles(false)} />
      <FeatureEffects />
    </ShellContext.Provider>
  );
}
