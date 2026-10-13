import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ChannelDTO, RoutineDTO } from '@ant/shared';
import {
  ConnectionBanner,
  FALLBACK_POLL_MS,
  PROBE_PATH,
  PROBE_TIMEOUT_MS,
  REALTIME_GRACE_MS,
} from '../src/components/layout/ConnectionBanner';
import { ConfirmProvider } from '../src/components/Modal';
import { ConversationPage } from '../src/routes/Conversation';
import { ApprovalsPage } from '../src/routes/Approvals';
import type { MessagePages } from '../src/lib/cache';
import { ConversationList } from '../src/components/layout/ConversationList';
import { AppShell } from '../src/components/layout/AppShell';
import { qk, useChannels, usePendingApprovals } from '../src/lib/queries';
import type { WsStatus } from '../src/lib/ws';
import { approval, bot, msg } from './fixtures';

/** A file of the UI package (jsdom's URL is not accepted by fileURLToPath: resolve to a string first). */
const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url).href), 'utf8');
const css = source('../src/index.css');
const themeInit = source('../public/theme-init.js');

/** Realtime status under the test's control. */
const ws = vi.hoisted(() => {
  let status = 'open';
  const listeners = new Set<() => void>();
  return {
    get: () => status,
    set: (s: string) => {
      status = s;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
});

vi.mock('../src/lib/ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/ws')>();
  const { useSyncExternalStore } = await import('react');
  return { ...actual, useWsStatus: () => useSyncExternalStore(ws.subscribe, ws.get) as WsStatus };
});

function renderWith(ui: ReactNode, { route = '/', qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }) } = {}) {
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  act(() => ws.set('open'));
});

describe('ConnectionBanner', () => {
  /** How many times the messages were refreshed. */
  const polled = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => JSON.stringify((c[0] as { queryKey?: unknown } | undefined)?.queryKey) === JSON.stringify(qk.messagesAll)).length;
  /** Advances the fake clock and lets the probe's promise settle. */
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const path = (input: unknown) => new URL(String(input), 'http://localhost').pathname;

  it('warns on every layout after a few seconds without realtime, and polls until it is back', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', fetchMock);
    const { qc } = renderWith(<ConnectionBanner />);
    const spy = vi.spyOn(qc, 'invalidateQueries');

    // The status alternates during the backoff: the delay counts from the first moment it is not open.
    act(() => ws.set('connecting'));
    await advance(REALTIME_GRACE_MS - 2_000);
    act(() => ws.set('closed'));
    expect(screen.queryByRole('status')).toBeNull();
    await advance(2_000);
    expect(screen.getByRole('status').textContent).toContain('Connexion temps réel perdue');

    // The server answers: what is on screen is refreshed right away, then every FALLBACK_POLL_MS.
    expect(fetchMock.mock.calls.map((c: unknown[]) => path(c[0]))).toContain(PROBE_PATH);
    expect(polled(spy)).toBe(1);
    act(() => ws.set('connecting'));
    await advance(FALLBACK_POLL_MS);
    expect(polled(spy)).toBe(2);
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.channels });
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.activeRuns });

    act(() => ws.set('open'));
    expect(screen.queryByRole('status')).toBeNull();
    await advance(FALLBACK_POLL_MS * 3);
    expect(polled(spy)).toBe(2);
  });

  it('is part of the app shell, above the page on every layout', () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    renderWith(
      <AppShell>
        <p>Page</p>
      </AppShell>,
      { route: '/c/dm1' },
    );
    act(() => ws.set('closed'));
    act(() => vi.advanceTimersByTime(REALTIME_GRACE_MS));
    const banner = screen.getByText('Connexion temps réel perdue').closest('[role="status"]')!;
    expect(banner).toBeTruthy();
    // Inside the main column (not in the desktop-only icon rail), before the page content.
    expect(banner.closest('.hidden')).toBeNull();
    expect(banner.compareDocumentPosition(screen.getByText('Page')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stays hidden for a short reconnection', () => {
    vi.useFakeTimers();
    renderWith(<ConnectionBanner />);
    act(() => ws.set('closed'));
    act(() => vi.advanceTimersByTime(REALTIME_GRACE_MS - 1_000));
    act(() => ws.set('open'));
    act(() => vi.advanceTimersByTime(REALTIME_GRACE_MS * 2));
    expect(screen.queryByRole('status')).toBeNull();
  });

  describe('while the server itself is unreachable', () => {
    const dev = bot({ id: 'b1', dmChannelId: 'dm1' });
    const group: ChannelDTO = {
      id: 'g1',
      kind: 'group',
      name: 'projet',
      topic: '',
      botIds: ['b1'],
      dmBotId: null,
      lastMessageAt: '2026-10-12T10:00:00.000Z',
      lastMessage: null,
      lastReadAt: null,
      createdAt: '2026-10-01T10:00:00.000Z',
    };

    /** The open conversation with the banner above it, as in the app shell. */
    function renderConversation(qc: QueryClient) {
      qc.setQueryData(qk.bots, [dev]);
      qc.setQueryData(qk.channels, [group]);
      qc.setQueryData<MessagePages>(qk.messages('g1'), { pages: [[msg({ id: 'm1', channelId: 'g1', content: 'Rapport prêt' })]], pageParams: [null] });
      qc.setQueryData(qk.activeRuns, []);
      return render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/c/g1']}>
            <ConfirmProvider>
              <ConnectionBanner />
              <Routes>
                <Route path="/c/:channelId" element={<ConversationPage />} />
              </Routes>
            </ConfirmProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    const expectConversationShown = () => {
      expect(screen.getByText('Rapport prêt')).toBeTruthy();
      expect(screen.getByPlaceholderText('Écrire dans projet…')).toBeTruthy();
      expect(screen.queryByText(/Vérifie ta connexion/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
    };

    it('keeps the open conversation on screen and does not refetch it while the server does not answer', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      vi.stubGlobal('fetch', fetchMock);
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      renderConversation(qc);
      await advance(0);
      expectConversationShown();
      const before = fetchMock.mock.calls.length;

      act(() => ws.set('closed'));
      await advance(REALTIME_GRACE_MS);
      await advance(FALLBACK_POLL_MS);
      await advance(FALLBACK_POLL_MS);

      // The banner says why nothing is refreshed, the last data stays readable and usable.
      expect(screen.getByRole('status').textContent).toContain('Serveur injoignable');
      expectConversationShown();
      expect(qc.getQueryState(qk.channels)?.status).toBe('success');
      expect(qc.getQueryState(qk.messages('g1'))?.status).toBe('success');
      // Only the probe went out: one per round.
      const after = fetchMock.mock.calls.slice(before).map((c: unknown[]) => path(c[0]));
      expect(after).toEqual([PROBE_PATH, PROBE_PATH, PROBE_PATH]);
    });

    it('polls again as soon as the server answers', async () => {
      vi.useFakeTimers();
      let up = false;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        if (!up) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify(path(input) === '/api/channels' ? [group] : []));
      });
      vi.stubGlobal('fetch', fetchMock);
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      renderConversation(qc);
      act(() => ws.set('closed'));
      await advance(REALTIME_GRACE_MS);
      expect(screen.getByRole('status').textContent).toContain('Serveur injoignable');

      up = true;
      const before = fetchMock.mock.calls.length;
      await advance(FALLBACK_POLL_MS);
      expect(screen.getByRole('status').textContent).toContain('Connexion temps réel perdue');
      expect(fetchMock.mock.calls.slice(before).map((c: unknown[]) => path(c[0]))).toContain('/api/channels');
    });

    it('gives up on a probe that hangs, so the next round still runs', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderWith(<ConnectionBanner />);
      act(() => ws.set('closed'));
      await advance(REALTIME_GRACE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(PROBE_TIMEOUT_MS);
      expect(screen.getByRole('status').textContent).toContain('Serveur injoignable');
      await advance(FALLBACK_POLL_MS - PROBE_TIMEOUT_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('Screens keep their data when a refresh fails', () => {
  /** Status of a query as its observers see it (TanStack notifies them after a tick): the page is up to date with it. */
  function ObservedStatus({ name, status }: { name: string; status: string }) {
    return <output aria-label={name}>{status}</output>;
  }
  const ChannelsStatus = () => <ObservedStatus name="channels" status={useChannels().status} />;
  const PendingStatus = () => <ObservedStatus name="pending" status={usePendingApprovals().status} />;
  const observed = (name: string) => screen.getByLabelText(name).textContent;

  const unreachable = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

  it('keeps the conversation when the channel list cannot be refreshed', async () => {
    unreachable();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(qk.bots, [bot({ id: 'b1' })]);
    qc.setQueryData<ChannelDTO[]>(qk.channels, [
      { id: 'g1', kind: 'group', name: 'projet', topic: '', botIds: ['b1'], dmBotId: null, lastMessageAt: null, lastMessage: null, lastReadAt: null, createdAt: '2026-10-01T10:00:00.000Z' },
    ]);
    qc.setQueryData<MessagePages>(qk.messages('g1'), { pages: [[msg({ id: 'm1', channelId: 'g1', content: 'Rapport prêt' })]], pageParams: [null] });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/c/g1']}>
          <ConfirmProvider>
            <ChannelsStatus />
            <Routes>
              <Route path="/c/:channelId" element={<ConversationPage />} />
            </Routes>
          </ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(() => qc.refetchQueries({ queryKey: qk.channels }));
    await waitFor(() => expect(observed('channels')).toBe('error'));
    expect(screen.getByPlaceholderText('Écrire dans projet…')).toBeTruthy();
    expect(screen.queryByText(/Vérifie ta connexion/)).toBeNull();
  });

  it('keeps the approvals list when it cannot be refreshed', async () => {
    unreachable();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(qk.bots, [bot({ id: 'b1' })]);
    qc.setQueryData(qk.approvals('pending'), [approval({ id: 'a1', title: 'Envoyer un e-mail à Marie' })]);
    qc.setQueryData(qk.approvals('all'), [approval({ id: 'a1', title: 'Envoyer un e-mail à Marie' })]);
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/approvals']}>
          <ConfirmProvider>
            <PendingStatus />
            <ApprovalsPage />
          </ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(() => qc.refetchQueries({ queryKey: qk.approvalsAll }));
    await waitFor(() => expect(observed('pending')).toBe('error'));
    expect(screen.getByText('Envoyer un e-mail à Marie')).toBeTruthy();
    expect(screen.queryByText(/Vérifie ta connexion/)).toBeNull();
  });

  it('still says why when there is nothing to show', async () => {
    unreachable();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/c/g1']}>
          <ConfirmProvider>
            <Routes>
              <Route path="/c/:channelId" element={<ConversationPage />} />
            </Routes>
          </ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Serveur injoignable. Vérifie ta connexion.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });
});

describe('Sidebar wording and selected row', () => {
  const dev = bot({ id: 'b1', dmChannelId: 'dm1', role: 'Développeur' });
  const channels: ChannelDTO[] = [
    { id: 'dm1', kind: 'dm', name: 'Dev', topic: '', botIds: ['b1'], dmBotId: 'b1', lastMessageAt: '2026-10-12T10:00:00.000Z', lastMessage: null, lastReadAt: null, createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'g1', kind: 'group', name: 'Kozmo', topic: '', botIds: ['b1'], dmBotId: null, lastMessageAt: null, lastMessage: null, lastReadAt: null, createdAt: '2026-10-01T10:00:00.000Z' },
  ];

  const setup = (route: string) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(qk.bots, [dev]);
    qc.setQueryData(qk.channels, channels);
    qc.setQueryData(qk.activeRuns, []);
    qc.setQueryData<RoutineDTO[]>(qk.routines, []);
    return renderWith(<ConversationList variant="sidebar" />, { route, qc });
  };

  it('names the team creation tile with an action, and bots "bots"', () => {
    setup('/');
    expect(screen.getByRole('button', { name: 'Nouvelle équipe' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Équipe' })).toBeNull();
    expect(screen.getByRole('tab', { name: /Conversations/ })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Bots' })).toBeTruthy();
    expect(screen.queryByText(/Agents/)).toBeNull();
  });

  it('raises the small grey text of the selected row', () => {
    setup('/c/dm1');
    const row = screen.getByRole('link', { name: /Dev/ });
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(row.className.split(' ')).toContain('group');
    expect(screen.getByTitle('Développeur').className).toContain('group-aria-[current=page]:text-fg');
  });
});

describe('theme-init.js', () => {
  it('applies a saved light theme to the browser bar colour before first paint', () => {
    const src = themeInit;
    // Served as is, not transpiled.
    expect(src).not.toMatch(/\?\.|=>|\blet\b|\bconst\b/);
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#1c1c1c';
    document.head.appendChild(meta);
    try {
      localStorage.setItem('ant-theme', 'light');
      new Function(src)();
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(meta.content).toBe('#ffffff');
      localStorage.setItem('ant-theme', 'dark');
      new Function(src)();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(meta.content).toBe('#1c1c1c');
    } finally {
      meta.remove();
      localStorage.removeItem('ant-theme');
    }
  });
});

describe('index.css', () => {
  it('keeps whole words in markdown table cells (the table scrolls instead)', () => {
    const rule = /\.md th,\s*\.md td\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/overflow-wrap:\s*normal/);
  });

  type Rgb = [number, number, number];
  const block = (selector: string) => {
    const start = css.indexOf(selector);
    return css.slice(start, css.indexOf('}', start));
  };
  const token = (b: string, name: string) => new RegExp(`--ant-${name}:\\s*([^;]+);`).exec(b)?.[1]?.trim() ?? '';
  const hex = (v: string): Rgb => [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rgb;
  /** Opaque colour of `value` (hex or "rgb(r g b / a)") painted over `bg`. */
  const paint = (value: string, bg: Rgb): Rgb => {
    const m = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(value);
    if (!m) return hex(value);
    const a = Number(m[4]);
    return [1, 2, 3].map((i, k) => Number(m[i]) * a + bg[k]! * (1 - a)) as Rgb;
  };
  const lum = (c: Rgb) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: Rgb, b: Rgb) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it('keeps small status text at 4.5:1 in the light theme', () => {
    const light = block("[data-theme='light'] {");
    const surface = hex(token(light, 'surface'));
    const card = hex(token(light, 'card'));
    const selected = paint(token(light, 'active'), surface);
    const warning = hex(token(light, 'warning'));
    const success = hex(token(light, 'success'));
    // "en file d’attente" in the sidebar, normal and selected; the "En pause" chip, normal and selected.
    expect(ratio(warning, surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(warning, selected)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(warning, paint(token(light, 'warning-soft'), surface))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(warning, paint(token(light, 'warning-soft'), selected))).toBeGreaterThanOrEqual(4.5);
    // The "Active" routine chip on a card.
    expect(ratio(success, paint(token(light, 'success-soft'), card))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(success, paint(token(light, 'success-soft'), surface))).toBeGreaterThanOrEqual(4.5);
    // Selected row: the timestamp switches to muted.
    expect(ratio(hex(token(light, 'muted')), selected)).toBeGreaterThanOrEqual(4.5);
  });

  it('gives the selected sidebar row readable variants in the dark theme', () => {
    const dark = block(':root,');
    const surface = hex(token(dark, 'surface'));
    const selected = paint(token(dark, 'active'), surface);
    const chipOnSelected = paint(token(dark, 'active'), selected);
    // Timestamp (subtle → muted) and role chip (muted → fg) on the selected row.
    expect(ratio(hex(token(dark, 'muted')), selected)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(token(dark, 'fg')), chipOnSelected)).toBeGreaterThanOrEqual(4.5);
  });
});
