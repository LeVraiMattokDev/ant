import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ListChecks, TriangleAlert } from 'lucide-react';
import type { AuthStateDTO, MessageDTO } from '@ant/shared';
import { App } from '../src/App';
import { MessageItem } from '../src/components/chat/MessageItem';
import { VncScreen } from '../src/components/computer/VncScreen';
import { AppShell } from '../src/components/layout/AppShell';
import { useShell } from '../src/components/layout/shell';
import { qk } from '../src/lib/queries';
import { realtime } from '../src/lib/ws';
import { bot, msg } from './fixtures';

/** A working module (« tracking ») next to a broken one (« ops »): every contribution of « ops » throws. */
const { boom } = vi.hoisted(() => ({
  boom: (): never => {
    throw new Error('boum');
  },
}));

vi.mock('../src/features/tracking', () => ({
  trackingFeature: {
    name: 'tracking',
    routes: [{ path: '/essai', element: <h1>Écran du module</h1> }],
    nav: [{ to: '/essai', label: 'Essai', icon: ListChecks, useBadge: () => 2 }],
    banners: [() => <div>Bannière du module</div>],
    railActions: [() => <button type="button">Action du rail</button>],
    messageExtras: [({ message }: { message: MessageDTO }) => <span>Pièce de {message.id}</span>],
  },
}));

vi.mock('../src/features/ops', () => ({
  opsFeature: {
    name: 'ops',
    nav: [{ to: '/casse', label: 'Cassé', icon: TriangleAlert, useBadge: boom }],
    banners: [boom],
    effects: [boom],
    railActions: [boom],
    messageExtras: [boom],
  },
}));

// The docked computer panel fails to render (e.g. its chunk is gone after an update).
vi.mock('../src/components/computer/ComputerPanel', () => ({ default: boom }));

/** noVNC stand-in: the test fires its events. */
const vnc = vi.hoisted(() => ({ instances: [] as EventTarget[] }));
vi.mock('@novnc/novnc', () => ({
  default: class extends EventTarget {
    viewOnly = true;
    scaleViewport = false;
    resizeSession = false;
    focusOnClick = false;
    background = '';
    qualityLevel = 6;
    compressionLevel = 2;
    constructor() {
      super();
      vnc.instances.push(this);
    }
    disconnect() {}
    focus() {}
  },
}));

const AUTH: AuthStateDTO = { setupRequired: false, authenticated: true, secondFactorPending: false, enrolmentPending: false, hasPasskey: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {}
}

function stubFetch(auth: AuthStateDTO = AUTH) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/auth/state') return json(auth);
      if (path === '/api/quota' || path === '/api/settings' || path === '/api/computer/status') return json({ error: 'not_found', message: 'Introuvable' }, 404);
      return json([]);
    }),
  );
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  vnc.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
  // Desktop layout: icon rail and docked computer panel.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  realtime.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a feature module that throws', () => {
  it('loses only its own contributions: the shell, the screen and the other modules stay', async () => {
    stubFetch();
    render(
      <QueryClientProvider client={newClient()}>
        <MemoryRouter initialEntries={['/essai']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Écran du module' })).toBeTruthy();
    expect(screen.getByText('Bannière du module')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Action du rail' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Essai (2 en attente)' })).toBeTruthy();
    // Its badge hook throws: the entry stays, without a badge.
    expect(screen.getByRole('link', { name: 'Cassé' }).getAttribute('href')).toBe('/casse');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('never takes a message down', () => {
    render(
      <QueryClientProvider client={newClient()}>
        <MemoryRouter>
          <MessageItem message={msg({ id: 'm1', content: 'Voici le rapport' })} bot={bot({ id: 'b1' })} bots={new Map()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Voici le rapport')).toBeTruthy();
    expect(screen.getByText('Pièce de m1')).toBeTruthy();
  });
});

describe('docked computer panel', () => {
  function OpenComputer() {
    const { toggleComputer } = useShell();
    return (
      <button type="button" onClick={toggleComputer}>
        Ouvrir l’ordinateur
      </button>
    );
  }

  it('stays in its column when it fails: the shell and the conversation remain usable', async () => {
    stubFetch();
    render(
      <QueryClientProvider client={newClient()}>
        <MemoryRouter initialEntries={['/c/dm1']}>
          <AppShell>
            <p>Conversation en cours</p>
            <OpenComputer />
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir l’ordinateur' }));
    expect(await screen.findByText('Le panneau Ordinateur n’a pas pu s’afficher.')).toBeTruthy();
    expect(screen.getByText('Conversation en cours')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeTruthy();
  });
});

describe('live screen when the connection drops', () => {
  const loggedOut: AuthStateDTO = { ...AUTH, authenticated: false };

  function renderScreen() {
    const qc = newClient();
    render(
      <QueryClientProvider client={qc}>
        <VncScreen interactive={false} />
      </QueryClientProvider>,
    );
    return qc;
  }

  const drop = () =>
    act(async () => {
      vnc.instances.at(-1)!.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: false } }));
    });

  it('stops reconnecting and says the session expired when the server confirms it is over', async () => {
    stubFetch(loggedOut);
    const qc = renderScreen();
    await waitFor(() => expect(vnc.instances).toHaveLength(1));
    await drop();
    expect(await screen.findByText('Session expirée : reconnecte-toi.')).toBeTruthy();
    expect(qc.getQueryData(qk.authState)).toEqual(loggedOut);
    await new Promise((r) => setTimeout(r, 1600));
    expect(vnc.instances).toHaveLength(1);
  });

  it('reconnects when the session is still valid', async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => expect(vnc.instances).toHaveLength(1));
    await drop();
    expect(await screen.findByText('Connexion à l’écran perdue.')).toBeTruthy();
    await waitFor(() => expect(vnc.instances).toHaveLength(2), { timeout: 2500 });
    expect(screen.queryByText('Session expirée : reconnecte-toi.')).toBeNull();
  });
});
