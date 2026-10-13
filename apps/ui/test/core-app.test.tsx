import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import type { AuthStateDTO, NudgeDTO } from '@ant/shared';
import { App } from '../src/App';
import { ErrorBoundary } from '../src/lib/error-boundary';
import { reloadForNewVersion } from '../src/lib/chunk-reload';
import { realtime } from '../src/lib/ws';
import { useToasts } from '../src/lib/toast';

// A screen whose chunk vanished with a deployment: the dynamic import fails.
vi.mock('../src/routes/Quota', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/Quota-0ld.js');
});

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

const AUTH: AuthStateDTO = { setupRequired: false, authenticated: true, secondFactorPending: false, enrolmentPending: false, hasPasskey: false };
const LISTS = new Set(['/api/channels', '/api/bots', '/api/runs/active', '/api/approvals', '/api/nudges', '/api/routines', '/api/tasks', '/api/runs']);

function stubFetch(handler: (path: string) => Response | Promise<Response> | undefined) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    return (await handler(path)) ?? new Response(JSON.stringify({ error: 'not_found', message: 'Introuvable' }), { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const seen: string[] = [];
function Where() {
  const l = useLocation();
  const at = `${l.pathname}${l.search}`;
  useEffect(() => {
    seen.push(at);
  }, [at]);
  return <output data-testid="where">{at}</output>;
}

function ToastProbe() {
  const toasts = useToasts();
  return <output data-testid="toasts">{toasts.map((t) => t.title).join('|')}</output>;
}

function renderApp(route: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <App />
        <Where />
        <ToastProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  seen.length = 0;
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  realtime.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session expired while the app is open', () => {
  it('goes to the login page with the current screen as `next`, without bouncing through the home page', async () => {
    let sessionGone = false;
    stubFetch(async (path) => {
      if (path === '/api/auth/state') {
        if (!sessionGone) return json(AUTH);
        // A real round trip: the cached "authenticated" state lives on meanwhile.
        await new Promise((r) => setTimeout(r, 40));
        return json({ ...AUTH, authenticated: false });
      }
      sessionGone = true;
      return json({ error: 'unauthorized', message: 'Session expirée.' }, 401);
    });
    renderApp('/approvals?id=X');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/login?next=%2Fapprovals%3Fid%3DX'));
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.getByTestId('where').textContent).toBe('/login?next=%2Fapprovals%3Fid%3DX');
    expect(seen).not.toContain('/');
    expect(seen).not.toContain('/login');
  });
});

describe('auth state answered by something else than the server', () => {
  it('keeps the owner in the app when a refetch gets a 200 HTML page (captive portal, proxy maintenance)', async () => {
    let portal = false;
    stubFetch((path) => {
      if (path === '/api/auth/state') {
        return portal ? new Response('<html><body>Connexion au Wi-Fi</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) : json(AUTH);
      }
      if (LISTS.has(path)) return json([]);
      return undefined;
    });
    const qc = renderApp('/approvals');
    await waitFor(() => expect(qc.getQueryData(['auth', 'state'])).toEqual(AUTH));
    portal = true;
    // e.g. the browser comes back online through a captive portal: the auth state is refetched.
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['auth', 'state'] });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('where').textContent).toBe('/approvals');
    expect(seen.some((at) => at.startsWith('/login'))).toBe(false);
    expect(screen.queryByText('Serveur injoignable. Vérifie ta connexion.')).toBeNull();
    expect(qc.getQueryData(['auth', 'state'])).toEqual(AUTH);
  });
});

describe('nudges', () => {
  it('show one toast: the one sent by the server', async () => {
    stubFetch((path) => {
      if (path === '/api/auth/state') return json(AUTH);
      if (path === '/api/bots') return json([]);
      if (LISTS.has(path)) return json([]);
      return undefined;
    });
    renderApp('/accueil');
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    const socket = FakeSocket.all[FakeSocket.all.length - 1]!;
    const nudge: NudgeDTO = { id: 'n1', botId: 'b1', kind: 'risque', title: 'Échéance', content: '', status: 'delivered', messageId: null, createdAt: '' };
    act(() => {
      socket.open();
      socket.receive({ type: 'nudge.created', nudge });
      socket.receive({ type: 'toast', level: 'info', title: 'Dev : Échéance', body: '', url: '/c/dm1' });
    });
    await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('Dev : Échéance'));
  });
});

describe('a screen that cannot load', () => {
  it('shows an error with a reload button instead of blanking the whole app', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch((path) => {
      if (path === '/api/auth/state') return json(AUTH);
      if (LISTS.has(path)) return json([]);
      return undefined;
    });
    renderApp('/quota');
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Recharger' })).toBeTruthy();
    // The shell (conversation list) is still there.
    expect(screen.getByRole('complementary', { name: 'Conversations et routines' })).toBeTruthy();
  });

  it('clears the error when the route changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/X.js')));
    const view = (key: string, ok: boolean) => (
      <div>
        <nav>coquille</nav>
        <ErrorBoundary resetKey={key}>
          <Suspense fallback="…">{ok ? <p>écran suivant</p> : <Broken />}</Suspense>
        </ErrorBoundary>
      </div>
    );
    const { rerender } = render(view('/quota', false));
    expect((await screen.findByRole('alert')).textContent).toContain('nouvelle version d’Ant');
    expect(screen.getByText('coquille')).toBeTruthy();
    rerender(view('/bots', true));
    expect(await screen.findByText('écran suivant')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reloads once for a missing chunk, never in a loop', () => {
    sessionStorage.clear();
    const reload = vi.fn();
    expect(reloadForNewVersion(reload, 1_000_000)).toBe(true);
    expect(reloadForNewVersion(reload, 1_005_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForNewVersion(reload, 1_020_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
