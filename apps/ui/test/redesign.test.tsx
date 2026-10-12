import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { BotDTO, ChannelDTO, RoutineDTO, RunDTO } from '@ant/shared';
import { ConfirmProvider } from '../src/components/Modal';
import { BotAvatar } from '../src/components/BotAvatar';
import { ModelSelector } from '../src/components/chat/ModelSelector';
import { Composer } from '../src/components/chat/Composer';
import { ConversationList } from '../src/components/layout/ConversationList';
import { RoutinesPage } from '../src/routes/Routines';
import { qk } from '../src/lib/queries';
import { useToasts } from '../src/lib/toast';
import { bot, run } from './fixtures';

function mockFetch(handler: (method: string, path: string, body: unknown) => { status?: number; body: unknown } | undefined) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const res = handler(init?.method ?? 'GET', url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined);
    if (!res) return new Response(JSON.stringify({ error: 'not_found', message: 'Introuvable' }), { status: 404 });
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function Where() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

function ToastProbe() {
  const toasts = useToasts();
  return <output data-testid="toasts">{toasts.map((t) => `${t.title}: ${t.body ?? ''}`).join('|')}</output>;
}

function renderWith(ui: ReactNode, { route = '/', qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }) } = {}) {
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[route]}>
          <ConfirmProvider>
            <Routes>
              <Route path="*" element={ui} />
            </Routes>
            <Where />
            <ToastProbe />
          </ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('BotAvatar', () => {
  it('draws eyes by default and the emoji when the owner chose one', () => {
    const { container, rerender } = render(<BotAvatar bot={{ slug: 'dev', name: 'Dev', avatar: '🐜' }} size={32} />);
    expect(container.querySelector('svg text')).toBeNull();
    expect(container.querySelectorAll('svg g > *').length).toBe(2);
    rerender(<BotAvatar bot={{ slug: 'dev', name: 'Dev', avatar: '🎧' }} size={32} label="Dev" />);
    expect(container.querySelector('svg text')?.textContent).toBe('🎧');
    expect(screen.getByRole('img', { name: 'Dev' })).toBeTruthy();
  });
});

describe('ModelSelector', () => {
  it('shows "Claude Sonnet 5.5 · Moyen" and patches the bot optimistically', async () => {
    const dev = bot({ id: 'b1' });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = mockFetch((method, path, body) =>
      method === 'PATCH' && path === '/api/bots/b1' ? { body: { ...dev, ...(body as object) } } : undefined,
    );
    fetchMock.mockImplementationOnce(async (_i, init) => {
      await gate;
      return new Response(JSON.stringify({ ...dev, ...JSON.parse(String(init?.body)) }), { status: 200 });
    });
    const { qc } = renderWith(<ModelSelector bot={dev} />);
    qc.setQueryData(qk.bots, [dev]);

    const pill = screen.getByRole('button', { name: /Modèle : Claude Sonnet 5.5, effort moyen/ });
    expect(pill.textContent).toContain('Claude Sonnet 5.5');
    expect(pill.textContent).toContain('· Moyen');
    fireEvent.click(pill);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: /Claude Sonnet 5.5/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Claude Opus 5.5/ }));

    // Optimistic: the cache changes before the server answers.
    await waitFor(() => expect(qc.getQueryData<BotDTO[]>(qk.bots)?.[0]?.model).toBe('claude-opus-5-5'));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/bots/b1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'claude-opus-5-5' });
    release();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Same effort again: nothing is sent.
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Moyen' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back and shows a toast when the server refuses', async () => {
    const dev = bot({ id: 'b1' });
    mockFetch(() => ({ status: 400, body: { error: 'invalid', message: 'Effort non pris en charge.' } }));
    const { qc } = renderWith(<ModelSelector bot={dev} />);
    qc.setQueryData(qk.bots, [dev]);
    fireEvent.click(screen.getByRole('button', { name: /Modèle/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Maximum' }));
    await waitFor(() => expect(screen.getByTestId('toasts').textContent).toContain('Modèle non modifié: Effort non pris en charge.'));
    expect(qc.getQueryData<BotDTO[]>(qk.bots)?.[0]?.effort).toBe('medium');
  });
});

describe('Composer "+" menu', () => {
  const dev = bot({ id: 'b1' });
  const xena = bot({ id: 'b2', slug: 'xena', name: 'Xena' });

  it('"Mentionner un bot" inserts @ and opens the autocomplete', async () => {
    renderWith(<Composer channelId="g1" members={[dev, xena]} placeholder="Écrire dans Kozmo…" routineBotId="b1" routineChannelId="g1" />);
    const textarea = screen.getByLabelText('Écrire dans Kozmo…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Salut', selectionStart: 5 } });
    fireEvent.click(screen.getByRole('button', { name: 'Plus d’actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mentionner un bot' }));
    await waitFor(() => expect(textarea.value).toBe('Salut @'));
    const list = await screen.findByRole('listbox', { name: 'Bots du canal' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['🛠️Dev@dev', '🛠️Xena@xena']); // the fixture bots have a custom emoji avatar
  });

  it('"Créer une routine" opens the creation flow prefilled', async () => {
    renderWith(<Composer channelId="g1" members={[dev, xena]} placeholder="Écrire" routineBotId="b2" routineChannelId="g1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Plus d’actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Créer une routine' }));
    expect(screen.getByTestId('where').textContent).toBe('/routines?new=1&bot=b2&channel=g1');
  });

  it('hides the mention action in a one-bot conversation', async () => {
    renderWith(<Composer channelId="dm1" members={[dev]} placeholder="Écrire à Dev…" routineBotId="b1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Plus d’actions' }));
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Mentionner un bot' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Ouvrir l’ordinateur' })).toBeTruthy();
  });
});

describe('ConversationList', () => {
  const dev = bot({ id: 'b1', dmChannelId: 'dm1', role: 'Responsable du développement' });
  const xena = bot({ id: 'b2', slug: 'xena', name: 'Xena', role: 'Community manager', dmChannelId: 'dm2', createdAt: '2026-10-02T10:00:00.000Z' });
  const channels: ChannelDTO[] = [
    {
      id: 'dm1',
      kind: 'dm',
      name: 'Dev',
      topic: '',
      botIds: ['b1'],
      dmBotId: 'b1',
      lastMessageAt: '2026-10-12T10:00:00.000Z',
      lastMessage: { content: 'Corrige le **menu**', authorKind: 'user', botId: null, createdAt: '2026-10-12T10:00:00.000Z' },
      createdAt: '2026-10-01T10:00:00.000Z',
    },
    {
      id: 'dm2',
      kind: 'dm',
      name: 'Xena',
      topic: '',
      botIds: ['b2'],
      dmBotId: 'b2',
      lastMessageAt: '2026-10-12T09:00:00.000Z',
      lastMessage: { content: 'Voici des brouillons.', authorKind: 'bot', botId: 'b2', createdAt: '2026-10-12T09:00:00.000Z' },
      createdAt: '2026-10-01T10:00:00.000Z',
    },
    {
      id: 'g1',
      kind: 'group',
      name: 'Kozmo',
      topic: 'Lancement',
      botIds: ['b1', 'b2'],
      dmBotId: null,
      lastMessageAt: null,
      lastMessage: null,
      createdAt: '2026-10-01T10:00:00.000Z',
    },
  ];

  const setup = (route = '/') => {
    mockFetch(() => undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(qk.bots, [xena, dev]);
    qc.setQueryData(qk.channels, channels);
    qc.setQueryData<RunDTO[]>(qk.activeRuns, [run({ id: 'r1', botId: 'b2', channelId: 'dm2' })]);
    qc.setQueryData<RoutineDTO[]>(qk.routines, []);
    return renderWith(<ConversationList variant="sidebar" />, { route, qc });
  };

  it('lists teams and bots with role, preview and live state', () => {
    setup();
    expect(screen.getByRole('link', { name: /Kozmo/ }).getAttribute('href')).toBe('/c/g1');
    const agents = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('link');
    // Creation order, not alphabetical.
    expect(agents.map((a) => a.getAttribute('href'))).toEqual(['/c/dm1', '/c/dm2']);
    expect(agents[0]?.textContent).toContain('Responsable du développement');
    expect(agents[0]?.textContent).toContain('Toi : Corrige le menu');
    // Xena has a running run in her DM.
    expect(agents[1]?.textContent).toContain('écrit…');
    expect(agents[1]?.textContent).not.toContain('Voici des brouillons');
  });

  it('filters live and sends Enter to the global search', () => {
    setup();
    const input = screen.getByRole('textbox', { name: /Rechercher/ });
    fireEvent.change(input, { target: { value: 'communi' } });
    const agents = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('link');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.textContent).toContain('Xena');
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByTestId('where').textContent).toBe('/search?q=communi');
  });

  it('switches to the routines tab', async () => {
    setup();
    fireEvent.click(screen.getByRole('tab', { name: /Routines/ }));
    expect(await screen.findByText(/Aucune routine/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Nouvelle routine/ }).getAttribute('href')).toBe('/routines?new=1');
  });
});

describe('RoutinesPage deep link', () => {
  it('opens the creation form prefilled with the bot from the conversation', async () => {
    const dev = bot({ id: 'b1' });
    const xena = bot({ id: 'b2', slug: 'xena', name: 'Xena', dmChannelId: 'dm2' });
    mockFetch((method, path) => {
      if (path === '/api/routines') return { body: [] };
      if (path === '/api/bots') return { body: [dev, xena] };
      if (path === '/api/channels') return { body: [] };
      return undefined;
    });
    renderWith(<RoutinesPage />, { route: '/routines?new=1&bot=b2' });
    const select = (await screen.findByLabelText('Bot')) as HTMLSelectElement;
    expect(select.value).toBe('b2');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/routines'));
  });
});
