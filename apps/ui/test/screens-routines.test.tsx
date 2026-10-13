import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { RoutineDTO } from '@ant/shared';
import { ConfirmProvider } from '../src/components/Modal';
import { NewRoutine } from '../src/components/routines/NewRoutine';
import { RoutinesPage, isProposal } from '../src/routes/Routines';
import { bot } from './fixtures';

type Handler = (method: string, path: string, body: unknown) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }> | undefined;

function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const res = await handler(init?.method ?? 'GET', url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined);
    if (!res) return new Response(JSON.stringify({ error: 'not_found', message: 'Introuvable' }), { status: 404 });
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderWith(ui: ReactNode, route = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <ConfirmProvider>
          <Routes>
            <Route path="*" element={ui} />
          </Routes>
        </ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function routine(p: Partial<RoutineDTO> & { id: string }): RoutineDTO {
  return {
    botId: 'b1',
    channelId: 'dm1',
    sourceText: 'chaque lundi à 8h',
    cron: '0 8 * * 1',
    timezone: 'Europe/Zurich',
    description: 'Chaque lundi à 08:00',
    instruction: 'Fais le point',
    urgent: false,
    enabled: true,
    proposed: false,
    completionPush: null,
    silentIfNothing: false,
    lastRunAt: null,
    nextRuns: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    ...p,
  };
}

const preview = { body: { description: 'Chaque lundi à 08:00', nextRuns: ['2026-10-19T06:00:00.000Z'] } };

afterEach(() => vi.unstubAllGlobals());

describe('NewRoutine without the interpretation', () => {
  it('offers manual entry when the worker does not answer, and creates the routine from it', async () => {
    const created = vi.fn();
    const fetchMock = mockFetch((method, path, body) => {
      if (path === '/api/routines/parse') {
        return { status: 504, body: { error: 'parse_timeout', message: 'Le worker n’a pas répondu à temps. Saisis l’horaire manuellement (expression cron).' } };
      }
      if (path === '/api/routines/preview') return preview;
      if (method === 'POST' && path === '/api/routines') {
        created(body);
        return { body: routine({ id: 'r1' }) };
      }
      return undefined;
    });
    const onDone = vi.fn();
    renderWith(<NewRoutine bots={[bot({ id: 'b1' })]} channels={[]} onDone={onDone} />);

    fireEvent.change(screen.getByLabelText('Ce que tu veux, quand tu le veux'), { target: { value: 'chaque lundi à 8h, fais le point' } });
    fireEvent.click(screen.getByRole('button', { name: 'Interpréter' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Le worker n’a pas répondu à temps');

    // The way out named by the message is on screen.
    fireEvent.click(within(alert).getByRole('button', { name: 'Saisir l’horaire moi-même' }));
    expect(screen.queryByRole('alert')).toBeNull();
    const cron = screen.getByLabelText('Expression cron') as HTMLInputElement;
    expect(cron.value).toBe('');
    expect((screen.getByLabelText('Consigne donnée au bot') as HTMLTextAreaElement).value).toBe('chaque lundi à 8h, fais le point');
    const create = screen.getByRole('button', { name: 'Créer la routine' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    fireEvent.change(cron, { target: { value: '0 8 * * 1' } });
    fireEvent.change(screen.getByLabelText('Consigne donnée au bot'), { target: { value: 'Fais le point sur la semaine' } });
    fireEvent.click(create);
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(created.mock.calls[0]![0]).toMatchObject({ botId: 'b1', cron: '0 8 * * 1', instruction: 'Fais le point sur la semaine', enabled: true });
    expect(created.mock.calls[0]![0]).not.toHaveProperty('timezone');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalled();
  });

  it('lets the owner stop waiting, and a late interpretation does not overwrite the manual draft', async () => {
    let answer: (v: { body: unknown }) => void = () => {};
    mockFetch((_method, path) => {
      if (path === '/api/routines/parse') return new Promise((resolve) => (answer = resolve));
      if (path === '/api/routines/preview') return preview;
      return undefined;
    });
    renderWith(<NewRoutine bots={[bot({ id: 'b1' })]} channels={[]} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText('Ce que tu veux, quand tu le veux'), { target: { value: 'chaque jour à 7h, la météo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Interpréter' }));
    expect(await screen.findByText(/Haiku interprète ta demande/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Saisir l’horaire moi-même' }));
    const cron = screen.getByLabelText('Expression cron') as HTMLInputElement;
    fireEvent.change(cron, { target: { value: '30 6 * * *' } });
    expect(screen.queryByText(/Haiku interprète ta demande/)).toBeNull();

    answer({ body: { cron: '0 7 * * *', timezone: 'Europe/Zurich', instruction: 'Donne la météo', urgent: false, description: 'Chaque jour à 07:00' } });
    await new Promise((r) => setTimeout(r, 20));
    expect((screen.getByLabelText('Expression cron') as HTMLInputElement).value).toBe('30 6 * * *');
    expect(screen.queryByText(/Lecture proposée/)).toBeNull();
  });
});

describe('RoutinesPage without any bot', () => {
  it('explains that a bot is needed instead of opening an unusable form', async () => {
    mockFetch((_method, path) => {
      if (path === '/api/routines') return { body: [] };
      if (path === '/api/bots') return { body: [] };
      if (path === '/api/channels') return { body: [] };
      return undefined;
    });
    // Same entry point as the sidebar link and the "+" menu.
    renderWith(<RoutinesPage />, '/routines?new=1');
    expect(await screen.findByText(/Une routine est confiée à un bot/)).toBeTruthy();
    const links = screen.getAllByRole('link', { name: /Créer d’abord un bot/ });
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.getAttribute('href')).toBe('/bots/new');
    expect(screen.queryByLabelText('Bot')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Interpréter' })).toBeNull();
  });
});

describe('isProposal', () => {
  it('trusts the server flag: a routine the owner paused before its first run is not a proposal', () => {
    expect(isProposal(routine({ id: 'r1', enabled: false, proposed: false }))).toBe(false);
    expect(isProposal(routine({ id: 'r2', enabled: false, proposed: true }))).toBe(true);
    expect(isProposal(routine({ id: 'r3', enabled: true, proposed: true }))).toBe(false);
  });

  it('does not guess from the history: a disabled routine never run is a proposal only when flagged', () => {
    expect(isProposal(routine({ id: 'r4', enabled: false }))).toBe(false);
    expect(isProposal(routine({ id: 'r5', enabled: false, proposed: true, lastRunAt: '2026-10-01T10:00:00.000Z' }))).toBe(true);
  });
});
