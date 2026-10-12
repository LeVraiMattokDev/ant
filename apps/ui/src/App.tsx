import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { setUnauthorizedHandler } from './lib/api';
import { qk, useAuthState } from './lib/queries';
import { realtime } from './lib/ws';
import { pushToast } from './lib/toast';
import { AppShell } from './components/layout/AppShell';
import { Toaster } from './components/Toaster';
import { ConfirmProvider } from './components/Modal';
import { LoadingBlock, ErrorBlock } from './components/ui';
import { LoginPage } from './routes/Login';
import { SetupPage } from './routes/Setup';
import { HomePage } from './routes/Home';
import { ConversationPage } from './routes/Conversation';
import { BotsPage } from './routes/Bots';
import { BotDetailPage } from './routes/BotDetail';
import { SearchPage } from './routes/Search';
import { RoutinesPage } from './routes/Routines';
import { MemoryPage } from './routes/Memory';
import { ApprovalsPage } from './routes/Approvals';
import { AuditPage } from './routes/Audit';
import { SettingsPage } from './routes/Settings';
import { NotFoundPage } from './routes/NotFound';

// Heavy screens (noVNC + xterm, charts) are split out of the main bundle.
const ComputerPage = lazy(() => import('./routes/Computer'));
const QuotaPage = lazy(() => import('./routes/Quota'));

function Splash() {
  return (
    <div className="flex h-full items-center justify-center">
      <LoadingBlock label="Connexion à Ant…" />
    </div>
  );
}

/** Starts the realtime connection while the session is fully authenticated. */
function useRealtime(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    realtime.start(qc, {
      onNudge: (n) => {
        const bot = qc.getQueryData<{ id: string; name: string }[]>(qk.bots)?.find((b) => b.id === n.botId);
        pushToast({ level: 'info', title: `Relance${bot ? ` de ${bot.name}` : ''}`, body: n.title, url: '/' });
      },
    });
    return () => realtime.stop();
  }, [enabled, qc]);
}

function ProtectedApp() {
  const auth = useAuthState();
  const location = useLocation();
  const ready = auth.data?.authenticated === true;
  useRealtime(ready);

  if (auth.isPending) return <Splash />;
  if (auth.isError) return <ErrorBlock error={auth.error} onRetry={() => void auth.refetch()} />;
  const s = auth.data;
  if (s.setupRequired || s.enrolmentPending) return <Navigate to="/setup" replace />;
  if (!s.authenticated) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'} replace />;
  }

  return (
    <AppShell>
      <Suspense fallback={<LoadingBlock />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/c/:channelId" element={<ConversationPage />} />
          <Route path="/c/:channelId/t/:messageId" element={<ConversationPage />} />
          <Route path="/bots" element={<BotsPage />} />
          <Route path="/bots/new" element={<BotDetailPage />} />
          <Route path="/bots/:botId" element={<BotDetailPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/computer" element={<ComputerPage />} />
          <Route path="/routines" element={<RoutinesPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/quota" element={<QuotaPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

export function App() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      realtime.stop();
      void qc.invalidateQueries({ queryKey: qk.authState });
      if (!/^\/(login|setup)/.test(window.location.pathname)) navigate('/login', { replace: true });
    });
  }, [qc, navigate]);

  // Notification clicks handled by the service worker navigate inside the already-open app.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data: unknown = e.data;
      if (data && typeof data === 'object' && (data as { type?: unknown }).type === 'ant:navigate') {
        const url = (data as { url?: unknown }).url;
        if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) navigate(url);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  return (
    <ConfirmProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/*" element={<ProtectedApp />} />
      </Routes>
      <Toaster />
    </ConfirmProvider>
  );
}
