import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { DEFAULT_SETTINGS, type AuthStateDTO, type BotDTO, type NetworkInfoDTO, type QuotaStatusDTO } from '@ant/shared';
import { ConfirmProvider } from '../src/components/Modal';
import { NewChannelModal } from '../src/components/chat/NewChannelModal';
import { confirmSessionEnded } from '../src/components/computer/session';
import { TerminalView } from '../src/components/computer/TerminalView';
import { PausedBanner } from '../src/components/layout/PausedBanner';
import { NewRoutine } from '../src/components/routines/NewRoutine';
import { SecuritySection, plainAddress } from '../src/components/settings/SecuritySection';
import { ApiError } from '../src/lib/api';
import { registerPasskey } from '../src/lib/passkey';
import { MESSAGES_PAGE_SIZE, nextMessagesCursor, qk } from '../src/lib/queries';
import { SESSION_CLOSE_CODE } from '../src/lib/ws';
import { SetupPage } from '../src/routes/Setup';
import { SettingsPage } from '../src/routes/Settings';
import { bot, msg } from './fixtures';

vi.mock('../src/lib/passkey', () => ({
  passkeysSupported: () => true,
  defaultPasskeyName: () => 'Mac — test',
  registerPasskey: vi.fn(async (name: string) => ({ id: 'pk1', name, createdAt: '2026-10-12T10:00:00.000Z', lastUsedAt: null })),
  loginWithPasskey: vi.fn(),
}));

// xterm needs a canvas: the terminal itself is not under test, only its connection.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

type Reply = { status?: number; body: unknown };
type Call = { method: string; path: string; body: unknown };

function mockFetch(handler: (method: string, path: string, body: unknown) => Reply | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      const res = handler(method, url.pathname, body);
      if (!res) return new Response(JSON.stringify({ error: 'not_found', message: 'Introuvable' }), { status: 404 });
      return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
    }),
  );
  return calls;
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

function renderWith(ui: ReactNode, { route = '/', qc = newClient() } = {}) {
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[route]}>
          <ConfirmProvider>
            <Routes>
              <Route path="/login" element={<p>connexion</p>} />
              <Route path="*" element={ui} />
            </Routes>
          </ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

function mockTouch(touch: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: touch && query.includes('pointer: coarse'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(registerPasskey).mockClear();
  sessionStorage.clear();
});

describe('message paging', () => {
  it('asks for older messages by the id of the oldest one shown', () => {
    const page = Array.from({ length: MESSAGES_PAGE_SIZE }, (_, i) => msg({ id: `m${i}`, createdAt: '2026-10-12T10:00:00.000Z' }));
    expect(nextMessagesCursor(page)).toBe('m0');
    expect(nextMessagesCursor(page.slice(1))).toBeUndefined();
  });
});

describe('Réglages → Sécurité', () => {
  const network: NetworkInfoDTO = { peerAddress: '::ffff:192.168.1.20', clientIp: '203.0.113.5', forwardedFor: '203.0.113.5', trustProxy: 'true', trustAll: true };
  const server = (overrides: Partial<NetworkInfoDTO> = {}) =>
    mockFetch((_m, path) => {
      if (path === '/api/auth/sessions' || path === '/api/auth/passkeys') return { body: [] };
      if (path === '/api/auth/password') return { body: { ok: true } };
      if (path === '/api/system/network') return { body: { ...network, ...overrides } };
      return undefined;
    });

  it('asks for the password before adding a passkey', async () => {
    server();
    renderWith(<SecuritySection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une passkey' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ajouter une passkey' });
    const submit = within(dialog).getByRole('button', { name: 'Continuer' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Mot de passe actuel'), { target: { value: 'ma phrase secrète' } });
    await act(async () => {
      fireEvent.click(submit);
    });
    await waitFor(() => expect(registerPasskey).toHaveBeenCalledWith('Mac — test', 'ma phrase secrète'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the dialog open with the reason when the password is wrong', async () => {
    server();
    vi.mocked(registerPasskey).mockRejectedValueOnce(new ApiError(401, 'invalid_credentials', 'Mot de passe incorrect.'));
    renderWith(<SecuritySection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une passkey' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ajouter une passkey' });
    fireEvent.change(within(dialog).getByLabelText('Mot de passe actuel'), { target: { value: 'pas le bon' } });
    await act(async () => {
      fireEvent.submit(dialog.querySelector('form')!);
    });
    expect(await within(dialog).findByText('Mot de passe incorrect.')).toBeTruthy();
    expect((within(dialog).getByLabelText('Mot de passe actuel') as HTMLInputElement).value).toBe('');
  });

  it('can remove every passkey while changing the password', async () => {
    const calls = server();
    renderWith(<SecuritySection />);
    const form = await screen.findByRole('form', { name: 'Changer le mot de passe' });
    fireEvent.change(within(form).getByLabelText('Mot de passe actuel'), { target: { value: 'ancienne phrase de passe' } });
    fireEvent.change(within(form).getByLabelText('Nouveau mot de passe'), { target: { value: 'une toute nouvelle phrase' } });
    fireEvent.change(within(form).getByLabelText('Confirmation'), { target: { value: 'une toute nouvelle phrase' } });
    fireEvent.click(within(form).getByLabelText(/Supprimer aussi toutes les passkeys/));
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(calls.find((c) => c.path === '/api/auth/password')?.body).toMatchObject({ revokePasskeys: true }));
  });

  it('shows the proxy address Ant sees, and warns when every proxy is trusted', async () => {
    server();
    renderWith(<SecuritySection />);
    expect(await screen.findByText('192.168.1.20')).toBeTruthy();
    const alert = await screen.findByText(/n’importe quel client peut choisir son adresse IP/);
    expect(alert.closest('[role="alert"]')?.textContent).toContain('TRUST_PROXY=192.168.1.20');
  });

  it('says when TRUST_PROXY already names that proxy exactly', async () => {
    server({ trustProxy: '192.168.1.20', trustAll: false });
    renderWith(<SecuritySection />);
    expect(await screen.findByText(/désigne exactement ce proxy/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('writes addresses the way TRUST_PROXY expects them', () => {
    expect(plainAddress('::ffff:10.0.0.7')).toBe('10.0.0.7');
    expect(plainAddress('fd00::1')).toBe('fd00::1');
  });
});

describe('Réglages → Se déconnecter', () => {
  it('also stops the notifications of this device', async () => {
    const unsubscribe = vi.fn(async () => true);
    const sub = { endpoint: 'https://push.example/1', options: { applicationServerKey: null }, toJSON: () => ({}), unsubscribe };
    const reg = { pushManager: { getSubscription: async () => sub } };
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => reg, ready: Promise.resolve(reg), addEventListener: () => {}, removeEventListener: () => {} },
    });
    const win = window as unknown as Record<string, unknown>;
    win.PushManager = function PushManager() {};
    win.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
    const calls = mockFetch((method, path) => {
      if (path === '/api/settings') return { body: DEFAULT_SETTINGS };
      if (path === '/api/bots' || path === '/api/auth/sessions' || path === '/api/auth/passkeys') return { body: [] };
      if (path === '/api/push/public-key') return { body: { publicKey: null } };
      if (method === 'POST' && (path === '/api/push/unsubscribe' || path === '/api/auth/logout')) return { body: { ok: true } };
      return undefined;
    });
    try {
      renderWith(<SettingsPage />, { route: '/settings' });
      fireEvent.click(await screen.findByRole('button', { name: 'Se déconnecter' }));
      expect(await screen.findByText('connexion')).toBeTruthy();
      expect(unsubscribe).toHaveBeenCalled();
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/push/unsubscribe', '/api/auth/logout']);
    } finally {
      delete (window.navigator as unknown as Record<string, unknown>).serviceWorker;
      delete win.PushManager;
      delete win.Notification;
    }
  });
});

describe('SetupPage: passkey step', () => {
  const state: AuthStateDTO = { setupRequired: true, authenticated: false, secondFactorPending: false, enrolmentPending: false, hasPasskey: false };
  const totp = { totpSecret: 'JBSWY3DPEHPK3PXP', totpUri: 'otpauth://totp/Ant?secret=JBSWY3DPEHPK3PXP' };

  async function toPasskeyStep() {
    fireEvent.change(await screen.findByLabelText('Code à 6 chiffres'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier' }));
    fireEvent.click(await screen.findByLabelText(/J’ai noté mes codes dans un endroit sûr/));
    fireEvent.click(screen.getByRole('button', { name: 'J’ai noté mes codes' }));
    return screen.findByRole('button', { name: 'Ajouter une passkey' });
  }

  it('confirms the passkey with the password chosen at the first step', async () => {
    mockFetch((method, path) => {
      if (path === '/api/auth/state') return { body: state };
      if (method === 'POST' && path === '/api/auth/setup') return { body: totp };
      if (method === 'POST' && path === '/api/auth/setup/totp') return { body: { recoveryCodes: ['aaaa-bbbb'] } };
      return undefined;
    });
    renderWith(<SetupPage />, { route: '/setup' });
    fireEvent.change(await screen.findByLabelText('Jeton d’initialisation'), { target: { value: 'jeton' } });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'une très longue phrase de passe 2026' } });
    fireEvent.change(screen.getByLabelText('Confirmation'), { target: { value: 'une très longue phrase de passe 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    const add = await toPasskeyStep();
    // Not asked again: it was typed a minute ago.
    expect(screen.queryByLabelText('Ton mot de passe')).toBeNull();
    await act(async () => {
      fireEvent.click(add);
    });
    await waitFor(() => expect(registerPasskey).toHaveBeenCalledWith('Mac — test', 'une très longue phrase de passe 2026'));
  });

  it('asks for the password again after a reload in the middle of the setup', async () => {
    sessionStorage.setItem('ant-setup-totp', JSON.stringify(totp));
    mockFetch((method, path) => {
      if (path === '/api/auth/state') return { body: { ...state, enrolmentPending: true } };
      if (method === 'POST' && path === '/api/auth/setup/totp') return { body: { recoveryCodes: ['aaaa-bbbb'] } };
      return undefined;
    });
    renderWith(<SetupPage />, { route: '/setup' });
    const add = (await toPasskeyStep()) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Ton mot de passe'), { target: { value: 'ma phrase' } });
    await act(async () => {
      fireEvent.click(add);
    });
    await waitFor(() => expect(registerPasskey).toHaveBeenCalledWith('Mac — test', 'ma phrase'));
  });
});

describe('NewRoutine on a phone', () => {
  const bots: BotDTO[] = [bot({ id: 'b1', name: 'Veille' })];

  it('adds a line on Enter, interprets with Ctrl+Enter or the button', async () => {
    mockTouch(true);
    const calls = mockFetch((_m, path) => (path === '/api/routines/parse' ? { body: { cron: '0 8 * * 1', timezone: 'Europe/Zurich', instruction: 'x', urgent: false, description: 'Tous les lundis à 08:00', nextRuns: [] } } : undefined));
    renderWith(<NewRoutine bots={bots} channels={[]} onDone={() => {}} />);
    const text = screen.getByLabelText('Ce que tu veux, quand tu le veux');
    fireEvent.change(text, { target: { value: 'chaque lundi à 8h, un point' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.path === '/api/routines/parse')).toHaveLength(0);
    fireEvent.keyDown(text, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/routines/parse')).toHaveLength(1));
  });

  it('interprets on Enter with a keyboard', async () => {
    mockTouch(false);
    const calls = mockFetch(() => undefined);
    renderWith(<NewRoutine bots={bots} channels={[]} onDone={() => {}} />);
    const text = screen.getByLabelText('Ce que tu veux, quand tu le veux');
    fireEvent.change(text, { target: { value: 'chaque lundi à 8h, un point' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/routines/parse')).toHaveLength(1));
  });
});

describe('équipe terminology', () => {
  it('names a group conversation an équipe when creating it', () => {
    mockFetch((_m, path) => (path === '/api/bots' ? { body: [] } : undefined));
    renderWith(<NewChannelModal open onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Nouvelle équipe' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Créer l’équipe' })).toBeTruthy();
    expect(screen.getByText('Sans @mention, c’est le premier bot de l’équipe qui répond.')).toBeTruthy();
  });
});

describe('worker down', () => {
  const quota = (worker: QuotaStatusDTO['worker']) => ({ allPaused: false, pausedReason: null, worker }) as unknown as QuotaStatusDTO;

  it('shows a banner over every screen while the worker does not answer', () => {
    const qc = newClient();
    qc.setQueryData(qk.quota, quota({ lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), alive: false }));
    renderWith(<PausedBanner />, { qc });
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('Le worker ne répond pas');
    expect(banner.textContent).toContain('docker compose logs worker');
    expect(banner.textContent).toContain('5 min');
  });

  it('shows nothing while it is alive', () => {
    const qc = newClient();
    qc.setQueryData(qk.quota, quota({ lastSeenAt: new Date().toISOString(), alive: true }));
    renderWith(<PausedBanner />, { qc });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('terminal and screen when the session ends', () => {
  const loggedOut: AuthStateDTO = { setupRequired: false, authenticated: false, secondFactorPending: false, enrolmentPending: false, hasPasskey: false };

  it('goes back to the login screen only when the server confirms the session is over', async () => {
    const qc = newClient();
    mockFetch((_m, path) => (path === '/api/auth/state' ? { body: loggedOut } : undefined));
    expect(await confirmSessionEnded(qc)).toBe(true);
    expect(qc.getQueryData(qk.authState)).toEqual(loggedOut);

    const qc2 = newClient();
    mockFetch((_m, path) => (path === '/api/auth/state' ? { body: { ...loggedOut, authenticated: true } } : undefined));
    expect(await confirmSessionEnded(qc2)).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await confirmSessionEnded(qc2)).toBe(false);
    expect(qc2.getQueryData(qk.authState)).toBeUndefined();
  });

  describe('terminal', () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 0;
      binaryType = 'blob';
      onopen: (() => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      constructor(public url: string) {
        sockets.push(this);
      }
      send() {}
      close() {}
    }
    beforeEach(() => {
      sockets.length = 0;
      vi.stubGlobal('WebSocket', FakeSocket);
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        },
      );
    });

    it('stops reconnecting and says the session expired on close code 4401', async () => {
      mockFetch((_m, path) => (path === '/api/auth/state' ? { body: loggedOut } : undefined));
      const { qc } = renderWith(<TerminalView interactive={false} />);
      expect(sockets).toHaveLength(1);
      act(() => {
        sockets[0]!.readyState = 1;
        sockets[0]!.onopen?.();
      });
      await act(async () => {
        sockets[0]!.onclose?.({ code: SESSION_CLOSE_CODE } as CloseEvent);
      });
      expect(await screen.findByText('Session expirée : reconnecte-toi.')).toBeTruthy();
      expect(qc.getQueryData(qk.authState)).toEqual(loggedOut);
      await new Promise((r) => setTimeout(r, 1600));
      expect(sockets).toHaveLength(1);
    });

    it('reconnects after an ordinary drop', async () => {
      mockFetch(() => undefined);
      renderWith(<TerminalView interactive={false} />);
      act(() => {
        sockets[0]!.readyState = 1;
        sockets[0]!.onopen?.();
      });
      act(() => {
        sockets[0]!.onclose?.({ code: 1006 } as CloseEvent);
      });
      expect(screen.getByText('Déconnecté, nouvelle tentative…')).toBeTruthy();
      await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2500 });
    });
  });
});
