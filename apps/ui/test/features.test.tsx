import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import type { AuthStateDTO, MessageDTO, ServerEvent } from '@ant/shared';
import { App } from '../src/App';
import { MessageItem } from '../src/components/chat/MessageItem';
import { realtime } from '../src/lib/ws';
import { dispatchServerEvent } from '../src/lib/ws-dispatch';
import { features } from '../src/features';
import { bot, msg } from './fixtures';

/** A feature module using every slot, in place of the (still empty) « tracking » module. */
const probe = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../src/features/tracking', () => ({
  trackingFeature: {
    name: 'tracking',
    routes: [{ path: '/essai', element: <h1>Écran du module</h1> }],
    bareRoutes: [{ path: '/guide', element: <h1>Guide plein écran</h1> }],
    nav: [{ to: '/essai', label: 'Essai', icon: ListChecks, useBadge: () => 3 }],
    banners: [() => <div>Bannière du module</div>],
    effects: [
      () => {
        probe.events.push('effect');
        return null;
      },
    ],
    railActions: [() => <button type="button">Action du rail</button>],
    homeCards: [() => <section>Carte du module</section>],
    messageExtras: [({ message }: { message: MessageDTO }) => <span>Pièce de {message.id}</span>],
    onEvent: (_qc: unknown, event: ServerEvent) => probe.events.push(event.type),
  },
}));

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
}

const AUTH: AuthStateDTO = { setupRequired: false, authenticated: true, secondFactorPending: false, enrolmentPending: false, hasPasskey: false };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function renderApp(route: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/auth/state') return json(AUTH);
      if (path === '/api/quota' || path === '/api/settings' || path === '/api/computer/status') {
        return new Response(JSON.stringify({ error: 'not_found', message: 'Introuvable' }), { status: 404 });
      }
      return json([]);
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  probe.events.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
  // Desktop layout: the icon rail is rendered.
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
});

afterEach(() => {
  realtime.stop();
  vi.unstubAllGlobals();
});

describe('feature modules', () => {
  it('are listed in a fixed order', () => {
    expect(features().map((f) => f.name)).toEqual(['tracking', 'ops', 'inputs', 'capabilities']);
  });

  it('add screens, rail entries with a badge, rail actions, banners and shell effects', async () => {
    renderApp('/essai');
    expect(await screen.findByRole('heading', { name: 'Écran du module' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Essai (3 en attente)' }).getAttribute('href')).toBe('/essai');
    expect(screen.getByRole('button', { name: 'Action du rail' })).toBeTruthy();
    expect(screen.getByText('Bannière du module')).toBeTruthy();
    await waitFor(() => expect(probe.events).toContain('effect'));
  });

  it('serve full-screen screens without the shell', async () => {
    renderApp('/guide');
    expect(await screen.findByRole('heading', { name: 'Guide plein écran' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Navigation principale' })).toBeNull();
    expect(screen.queryByText('Bannière du module')).toBeNull();
  });

  it('add dashboard cards', async () => {
    renderApp('/accueil');
    expect(await screen.findByText('Carte du module')).toBeTruthy();
  });

  it('render under messages and receive every realtime event', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <MessageItem message={msg({ id: 'm1', content: 'Voici le rapport' })} bot={bot({ id: 'b1' })} bots={new Map()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Pièce de m1')).toBeTruthy();
    dispatchServerEvent(qc, { type: 'followups.updated' });
    dispatchServerEvent(qc, { type: 'tasks.updated' });
    expect(probe.events).toEqual(['followups.updated', 'tasks.updated']);
  });
});
