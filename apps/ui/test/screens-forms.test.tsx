import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AuditEntryDTO, BotInput, ChannelDTO, SearchResultDTO } from '@ant/shared';
import { ConfirmProvider } from '../src/components/Modal';
import { SetupPage } from '../src/routes/Setup';
import { BotForm } from '../src/components/bots/BotForm';
import { sinceLabel } from '../src/routes/Computer';
import { Gauge } from '../src/components/ui';
import { ApprovalCard } from '../src/components/approvals/ApprovalCard';
import { resultPlace } from '../src/routes/Search';
import { AuditPage } from '../src/routes/Audit';
import { auditEventLabel, auditEventOptions, formatActor } from '../src/components/audit/labels';
import { qk } from '../src/lib/queries';
import { approval, bot, msg } from './fixtures';

type Reply = { status?: number; body: unknown };

function mockFetch(handler: (method: string, path: string, body: unknown, query: URLSearchParams) => Reply | undefined) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const res = handler(init?.method ?? 'GET', url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined, url.searchParams);
    if (!res) return new Response(JSON.stringify({ error: 'not_found', message: 'Introuvable' }), { status: 404 });
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderWith(ui: ReactNode, { route = '/', qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }) } = {}) {
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[route]}>
          <ConfirmProvider>
            <Routes>
              <Route path="*" element={ui} />
            </Routes>
          </ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sessionStorage.clear();
});

describe('SetupPage', () => {
  const enrolling = { setupRequired: true, authenticated: false, secondFactorPending: false, enrolmentPending: true, hasPasskey: false };

  it('goes back to the token step when the 10-minute enrolment session has expired', async () => {
    sessionStorage.setItem('ant-setup-totp', JSON.stringify({ totpSecret: 'JBSWY3DPEHPK3PXP', totpUri: 'otpauth://totp/Ant?secret=JBSWY3DPEHPK3PXP' }));
    mockFetch((method, path) => {
      if (path === '/api/auth/state') return { body: enrolling };
      if (method === 'POST' && path === '/api/auth/setup/totp') return { status: 401, body: { error: 'unauthenticated', message: 'Connexion requise.' } };
      return undefined;
    });
    renderWith(<SetupPage />, { route: '/setup' });
    const code = await screen.findByLabelText('Code à 6 chiffres');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier' }));

    // Back on the first step, with an explanation instead of "Connexion requise." in a loop.
    expect(await screen.findByLabelText('Jeton d’initialisation')).toBeTruthy();
    expect(screen.queryByLabelText('Code à 6 chiffres')).toBeNull();
    expect(screen.getByText(/Étape expirée/).textContent).toContain('nouveau QR code');
    expect(sessionStorage.getItem('ant-setup-totp')).toBeNull();
  });

  it('keeps the code step for a wrong code', async () => {
    sessionStorage.setItem('ant-setup-totp', JSON.stringify({ totpSecret: 'JBSWY3DPEHPK3PXP', totpUri: 'otpauth://totp/Ant?secret=JBSWY3DPEHPK3PXP' }));
    mockFetch((method, path) => {
      if (path === '/api/auth/state') return { body: enrolling };
      if (method === 'POST' && path === '/api/auth/setup/totp') return { status: 400, body: { error: 'invalid_code', message: 'Code incorrect.' } };
      return undefined;
    });
    renderWith(<SetupPage />, { route: '/setup' });
    fireEvent.change(await screen.findByLabelText('Code à 6 chiffres'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier' }));
    expect(await screen.findByText('Code incorrect.')).toBeTruthy();
    expect(screen.getByLabelText('Code à 6 chiffres')).toBeTruthy();
  });

  it('says where the token is with the documented .env (the logs show [secret])', async () => {
    mockFetch((_m, path) => (path === '/api/auth/state' ? { body: { ...enrolling, enrolmentPending: false } } : undefined));
    const { container } = renderWith(<SetupPage />, { route: '/setup' });
    await screen.findByLabelText('Jeton d’initialisation');
    expect(container.textContent).toContain('valeur de SETUP_TOKEN dans ton fichier .env');
    expect(container.textContent).toContain('grep SETUP_TOKEN .env');
    expect(container.textContent).not.toContain('affiché dans les journaux du conteneur');
  });
});

describe('BotForm validation', () => {
  it('keeps the button usable and says which field is missing', () => {
    const onSubmit = vi.fn();
    render(<BotForm onSubmit={onSubmit} saving={false} error={null} />);
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Dev' } });
    const submit = screen.getByRole('button', { name: 'Créer le bot' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('À corriger : rôle.');
    expect(screen.getByText('Décris en une phrase ce que fait ce bot.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Rôle'));

    fireEvent.change(screen.getByLabelText('Rôle'), { target: { value: 'Développeur' } });
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0]![0] as BotInput).role).toBe('Développeur');
  });

  it('flags an empty identifier once a submit was attempted', () => {
    render(<BotForm onSubmit={() => {}} saving={false} error={null} />);
    // Punctuation only: slugify gives an empty identifier.
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: '!!!' } });
    fireEvent.change(screen.getByLabelText('Rôle'), { target: { value: 'Testeur' } });
    expect(screen.queryByText(/Lettres minuscules/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Créer le bot' }));
    expect(screen.getByText(/Lettres minuscules/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('À corriger : identifiant.');
  });

  it.each(['5', '20000'])('does not let a hidden heartbeat interval (%s min) block the form, and keeps the stored one', (value) => {
    const onSubmit = vi.fn();
    render(<BotForm bot={bot({ id: 'b1', heartbeatIntervalMin: 60 })} onSubmit={onSubmit} saving={false} error={null} />);
    fireEvent.change(screen.getByLabelText('Intervalle en minutes'), { target: { value } });
    expect(screen.getByText('Entre 15 minutes et 7 jours.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Heartbeat' }));
    expect(screen.queryByLabelText('Intervalle en minutes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0]![0] as BotInput;
    expect(input.heartbeatEnabled).toBe(false);
    // Not the default (180): the interval stored for this bot is left as it was.
    expect(input.heartbeatIntervalMin).toBe(60);
  });

  it('flags an interval above 7 days inline instead of sending it to the server', () => {
    const onSubmit = vi.fn();
    render(<BotForm bot={bot({ id: 'b1' })} onSubmit={onSubmit} saving={false} error={null} />);
    const field = screen.getByLabelText('Intervalle en minutes');
    fireEvent.change(field, { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Entre 15 minutes et 7 jours.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('À corriger : intervalle du heartbeat.');
    expect(document.activeElement).toBe(field);

    // 7 days exactly is the server's upper bound.
    fireEvent.change(field, { target: { value: String(7 * 24 * 60) } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect((onSubmit.mock.calls[0]![0] as BotInput).heartbeatIntervalMin).toBe(10080);
  });

  it('uses the default interval for a new bot whose hidden interval was left invalid', () => {
    const onSubmit = vi.fn();
    render(<BotForm onSubmit={onSubmit} saving={false} error={null} />);
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Dev' } });
    fireEvent.change(screen.getByLabelText('Rôle'), { target: { value: 'Développeur' } });
    fireEvent.change(screen.getByLabelText('Intervalle en minutes'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Heartbeat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Créer le bot' }));
    expect((onSubmit.mock.calls[0]![0] as BotInput).heartbeatIntervalMin).toBe(180);
  });

  it('accepts an interval that is not a multiple of 5 (no native step validation)', () => {
    const onSubmit = vi.fn();
    render(<BotForm bot={bot({ id: 'b1' })} onSubmit={onSubmit} saving={false} error={null} />);
    fireEvent.change(screen.getByLabelText('Intervalle en minutes'), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect((onSubmit.mock.calls[0]![0] as BotInput).heartbeatIntervalMin).toBe(17);
  });

  it('uses quiet-hour fields wide enough for a 12-hour time', () => {
    render(<BotForm onSubmit={() => {}} saving={false} error={null} />);
    fireEvent.click(screen.getByLabelText('Heures propres à ce bot'));
    expect(screen.getByLabelText('Début du silence').className).toContain('w-32');
    expect(screen.getByLabelText('Fin du silence').className).toContain('w-32');
  });
});

describe('Computer status line', () => {
  const now = Date.parse('2026-10-13T10:00:00.000Z');
  it('never says "depuis à l’instant"', () => {
    expect(sinceLabel('2026-10-13T09:59:55.000Z', now)).toBe('à l’instant');
    expect(sinceLabel('2026-10-13T09:44:00.000Z', now)).toBe('depuis 16 min');
    expect(sinceLabel('2026-10-13T08:00:00.000Z', now)).toBe('depuis 2 h');
    // Server clock slightly ahead of the browser.
    expect(sinceLabel('2026-10-13T10:01:30.000Z', now)).toBe('à l’instant');
  });
});

describe('Gauge', () => {
  it('is a meter only when there is a value', () => {
    const { rerender } = render(<Gauge label="Fenêtre de 5 heures" value={null} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByRole('img', { name: 'Fenêtre de 5 heures : non disponible' })).toBeTruthy();
    rerender(<Gauge label="Fenêtre de 5 heures" value={42} />);
    const meter = screen.getByRole('meter', { name: 'Fenêtre de 5 heures' });
    expect(meter.getAttribute('aria-valuenow')).toBe('42');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
  });
});

describe('ApprovalCard past its deadline', () => {
  it('removes the buttons when the deadline passes while the card is on screen', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-13T10:00:00.000Z'));
    mockFetch(() => undefined);
    renderWith(<ApprovalCard approval={approval({ id: 'a1', expiresAt: '2026-10-13T10:00:02.000Z' })} bot={undefined} />);
    expect(screen.getByRole('button', { name: 'Approuver' })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(screen.queryByRole('button', { name: 'Approuver' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refuser' })).toBeNull();
    expect(screen.getByText('Expirée')).toBeTruthy();
    expect(screen.getByText(/Le bot devra redemander/)).toBeTruthy();
  });

  it('shows no buttons for an approval already past its deadline', () => {
    mockFetch(() => undefined);
    renderWith(<ApprovalCard approval={approval({ id: 'a2', expiresAt: '2020-01-01T00:00:00.000Z' })} bot={undefined} />);
    expect(screen.queryByRole('button', { name: 'Approuver' })).toBeNull();
    expect(screen.getByText('Expirée')).toBeTruthy();
  });

  it('reloads the approvals when the server answers 409', async () => {
    mockFetch((method, path) =>
      method === 'POST' && path === '/api/approvals/a3/decide' ? { status: 409, body: { error: 'already_decided', message: 'Déjà décidée.' } } : undefined,
    );
    const { qc } = renderWith(<ApprovalCard approval={approval({ id: 'a3' })} bot={undefined} />);
    qc.setQueryData(qk.approvals('pending'), [approval({ id: 'a3' })]);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Approuver' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: qk.approvalsAll }));
  });
});

describe('Search result place', () => {
  const channels: ChannelDTO[] = [
    { id: 'dm1', kind: 'dm', name: 'Xena', topic: '', botIds: ['b2'], dmBotId: 'b2', lastMessageAt: null, lastMessage: null, lastReadAt: null, createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'g1', kind: 'group', name: 'general', topic: '', botIds: ['b1', 'b2'], dmBotId: null, lastMessageAt: null, lastMessage: null, lastReadAt: null, createdAt: '2026-10-01T10:00:00.000Z' },
  ];
  const result = (p: Parameters<typeof msg>[0], channelName: string): SearchResultDTO => ({ message: msg(p), channelName, snippet: '' });
  const nameOf = (id: string) => (id === 'dm1' ? 'Xena' : '#general');

  it('does not repeat the bot name for its own DM replies', () => {
    expect(resultPlace(result({ id: 'm1', channelId: 'dm1', authorKind: 'bot', botId: 'b2' }, 'Xena'), channels, nameOf)).toBe('en privé');
    expect(resultPlace(result({ id: 'm2', channelId: 'dm1', authorKind: 'user', botId: null }, 'Xena'), channels, nameOf)).toBe('en privé avec Xena');
    expect(resultPlace(result({ id: 'm3', channelId: 'g1', authorKind: 'bot', botId: 'b2' }, 'general'), channels, nameOf)).toBe('#general');
    expect(resultPlace(result({ id: 'm4', channelId: 'gone', authorKind: 'bot', botId: 'b2' }, 'ancien'), channels, nameOf)).toBe('ancien');
  });
});

describe('Audit log in French', () => {
  it('labels events and actors, keeping unknown keys readable', () => {
    expect(auditEventLabel('bot.create')).toBe('Bot créé');
    expect(auditEventLabel('auth.setup.password')).toBe('Mot de passe défini');
    expect(auditEventLabel('something.new')).toBe('something.new');
    const bots = [{ slug: 'dev', name: 'Dev' }];
    expect(formatActor('owner', bots)).toBe('Toi');
    expect(formatActor('system', bots)).toBe('Système');
    expect(formatActor('bot:dev', bots)).toBe('Dev');
    expect(formatActor('bot:dev/general-purpose', bots)).toBe('Dev · sous-agent general-purpose');
    expect(formatActor('bot:old', bots)).toBe('@old');
    expect(auditEventOptions().some((o) => o.value === 'tool' && o.label === 'Appel d’outil')).toBe(true);
  });

  it('shows labels in the table and filters with the exact key the server expects', async () => {
    const rows: AuditEntryDTO[] = [
      { id: 2, at: '2026-10-12T10:00:00.000Z', actor: 'owner', event: 'bot.create', runId: null, tool: null, detail: {}, outcome: null, ip: null },
      { id: 1, at: '2026-10-12T09:00:00.000Z', actor: 'bot:dev', event: 'tool', runId: 'r1', tool: 'bash', detail: {}, outcome: 'ok', ip: null },
    ];
    const fetchMock = mockFetch((_m, path, _b, q) => {
      if (path === '/api/bots') return { body: [bot({ id: 'b1' })] };
      if (path === '/api/audit') return { body: q.get('event') ? rows.filter((r) => r.event === q.get('event')) : rows };
      return undefined;
    });
    renderWith(<AuditPage />, { route: '/audit' });
    const table = within(await screen.findByRole('table'));
    await screen.findByRole('option', { name: 'Dev' });
    expect(table.getByText('Bot créé').getAttribute('title')).toBe('bot.create');
    expect(table.getByText('Toi').getAttribute('title')).toBe('owner');
    expect(table.getByText('Dev').getAttribute('title')).toBe('bot:dev');
    expect(table.getByText('Appel d’outil')).toBeTruthy();
    expect(table.getByText('Réussi')).toBeTruthy();
    expect(table.queryByText('bot.create')).toBeNull();

    fireEvent.change(screen.getByLabelText('Filtrer par événement'), { target: { value: 'tool' } });
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('event=tool'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Filtrer par acteur'), { target: { value: 'bot:dev' } });
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('actor=bot%3Adev'))).toBe(true));
  });
});
