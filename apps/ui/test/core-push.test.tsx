import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { NotificationsSection } from '../src/components/settings/NotificationsSection';
import { SecuritySection } from '../src/components/settings/SecuritySection';
import { useLogout } from '../src/components/layout/useLogout';
import { ConfirmProvider } from '../src/components/Modal';
import { disablePush } from '../src/lib/push';
import { qk } from '../src/lib/queries';

const CURRENT_KEY = 'AQID'; // bytes 1, 2, 3
const OLD_KEY = new Uint8Array([4, 5, 6]);

interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => unknown;
  unsubscribe: ReturnType<typeof vi.fn>;
}

let current: FakeSub | null = null;
let endpointSeq = 0;
const subscribe = vi.fn();

function makeSub(key: Uint8Array): FakeSub {
  const endpoint = `https://push.example/${++endpointSeq}`;
  const sub: FakeSub = {
    endpoint,
    options: { applicationServerKey: key.slice().buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => {
      if (current === sub) current = null;
      return true;
    }),
  };
  return sub;
}

type Calls = { method: string; path: string }[];
function stubServer(opts: { subscribeStatus?: number; unsubscribeStatus?: number } = {}): Calls {
  const calls: Calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path });
      const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === '/api/push/public-key') return ok({ publicKey: CURRENT_KEY });
      if (path === '/api/push/subscribe') return ok({ ok: true }, opts.subscribeStatus ?? 200);
      if (path === '/api/push/unsubscribe') return ok({ ok: true }, opts.unsubscribeStatus ?? 200);
      if (path === '/api/auth/logout') return ok({ ok: true });
      if (path === '/api/auth/password') return ok({ ok: true });
      if (path === '/api/auth/sessions') return ok([]);
      if (path === '/api/auth/passkeys') return ok([]);
      return ok({ error: 'not_found', message: 'Introuvable' }, 404);
    }),
  );
  return calls;
}

const win = window as unknown as Record<string, unknown>;

beforeEach(() => {
  current = null;
  subscribe.mockReset();
  subscribe.mockImplementation(async (o: { applicationServerKey: Uint8Array }) => (current = makeSub(o.applicationServerKey)));
  const reg = { pushManager: { getSubscription: async () => current, subscribe } };
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => reg, ready: Promise.resolve(reg), addEventListener: () => {}, removeEventListener: () => {} },
  });
  win.PushManager = function PushManager() {};
  win.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
});

afterEach(() => {
  delete (window.navigator as unknown as Record<string, unknown>).serviceWorker;
  delete win.PushManager;
  delete win.Notification;
  vi.unstubAllGlobals();
});

function wrap(children: ReactNode, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings']}>
        <ConfirmProvider>{children}</ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('push status in the settings', () => {
  it('re-registers the subscription with the server before saying it is on', async () => {
    current = makeSub(new Uint8Array([1, 2, 3]));
    const calls = stubServer();
    render(wrap(<NotificationsSection />));
    expect(await screen.findByText('Activées sur cet appareil')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/push/subscribe')).toBe(true);
  });

  it('does not claim "on" for a subscription made with an old server key', async () => {
    current = makeSub(OLD_KEY);
    stubServer();
    render(wrap(<NotificationsSection />));
    expect(await screen.findByText('Désactivées')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Activer les notifications/ })).toBeTruthy();
  });

  it('rolls back a new subscription the server could not register', async () => {
    stubServer({ subscribeStatus: 500 });
    render(wrap(<NotificationsSection />));
    fireEvent.click(await screen.findByRole('button', { name: /Activer les notifications/ }));
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(current).toBeNull());
    expect(await screen.findByText('Désactivées')).toBeTruthy();
    expect(screen.queryByText('Activées sur cet appareil')).toBeNull();
  });

  it('replaces a subscription made with an old key when enabling', async () => {
    const old = makeSub(OLD_KEY);
    current = old;
    stubServer();
    render(wrap(<NotificationsSection />));
    fireEvent.click(await screen.findByRole('button', { name: /Activer les notifications/ }));
    expect(await screen.findByText('Activées sur cet appareil')).toBeTruthy();
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(current).not.toBe(old);
  });
});

describe('turning push off', () => {
  it('always removes the browser subscription, even when the server cannot be told', async () => {
    const sub = makeSub(new Uint8Array([1, 2, 3]));
    current = sub;
    stubServer({ unsubscribeStatus: 503 });
    await disablePush();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(current).toBeNull();
  });

  it('logging out unsubscribes this device first, and logs out even if that fails', async () => {
    const sub = makeSub(new Uint8Array([1, 2, 3]));
    current = sub;
    const calls = stubServer({ unsubscribeStatus: 503 });
    function LogoutButton() {
      const logout = useLogout();
      return (
        <button type="button" onClick={() => logout.mutate()}>
          Se déconnecter
        </button>
      );
    }
    render(
      wrap(
        <Routes>
          <Route path="/settings" element={<LogoutButton />} />
          <Route path="/login" element={<p>connexion</p>} />
        </Routes>,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }));
    expect(await screen.findByText('connexion')).toBeTruthy();
    expect(sub.unsubscribe).toHaveBeenCalled();
    const order = calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(order).toEqual(['/api/push/unsubscribe', '/api/auth/logout']);
  });
});

describe('changing the password', () => {
  it('refreshes the list of active sessions (the server revoked the others)', async () => {
    const calls = stubServer();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    render(wrap(<SecuritySection />, qc));
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/auth/sessions')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Mot de passe actuel'), { target: { value: 'ancienne phrase de passe' } });
    fireEvent.change(screen.getByLabelText('Nouveau mot de passe'), { target: { value: 'une toute nouvelle phrase' } });
    fireEvent.change(screen.getByLabelText('Confirmation'), { target: { value: 'une toute nouvelle phrase' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'Changer le mot de passe' }));
    });
    await waitFor(() => expect(calls.some((c) => c.path === '/api/auth/password')).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/auth/sessions')).toHaveLength(2));
    expect(qc.getQueryState(qk.sessions)?.status).toBe('success');
  });
});
