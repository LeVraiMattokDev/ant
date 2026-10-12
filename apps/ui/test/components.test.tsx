import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ConfirmProvider } from '../src/components/Modal';
import { MessageItem } from '../src/components/chat/MessageItem';
import { ApprovalCard } from '../src/components/approvals/ApprovalCard';
import { LoginPage } from '../src/routes/Login';
import { Snippet } from '../src/routes/Search';
import { UsageChart } from '../src/components/quota/UsageChart';
import { qk } from '../src/lib/queries';
import { approval, bot, msg } from './fixtures';

type Routes = Record<string, unknown>;

/** fetch mock answering `METHOD /path` (or `/path` for GET) with JSON. */
function mockFetch(routes: Routes) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = routes[`${method} ${url.pathname}`] ?? (method === 'GET' ? routes[url.pathname] : undefined);
    if (body === undefined) return new Response(JSON.stringify({ error: 'not_found', message: 'Introuvable' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderWith(ui: ReactNode, { route = '/', qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }) } = {}) {
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[route]}>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('MessageItem', () => {
  const dev = bot({ id: 'b1' });
  const bots = new Map([[dev.id, dev]]);

  it('renders markdown, author and chips; shows cost only for API runs', () => {
    renderWith(
      <MessageItem
        message={msg({
          id: 'm1',
          content: 'Voici le **plan**',
          meta: { model: 'claude-opus-5-5', effort: 'high', computeSource: 'api', costUsd: 0.0123 },
        })}
        bot={dev}
        bots={bots}
      />,
    );
    expect(screen.getByText('Dev')).toBeTruthy();
    expect(screen.getByText('plan').tagName).toBe('STRONG');
    expect(screen.getByText('Opus 5.5')).toBeTruthy();
    expect(screen.getByText('effort élevé')).toBeTruthy();
    expect(screen.getByText('Crédits API')).toBeTruthy();
    expect(screen.getByText('$0.0123')).toBeTruthy();
  });

  it('hides the cost on the subscription and shows the thread link', () => {
    renderWith(
      <MessageItem
        message={msg({ id: 'm2', content: 'ok', replyCount: 3, meta: { model: 'claude-sonnet-5-5', computeSource: 'subscription', costUsd: 0.5 } })}
        bot={dev}
        bots={bots}
        threadLink="/c/c1/t/m2"
      />,
    );
    expect(screen.getByText('Abonnement')).toBeTruthy();
    expect(screen.queryByText('$0.5000')).toBeNull();
    expect(screen.getByText('3 réponses')).toBeTruthy();
  });

  it('renders delegations as system events with the sub-agent model and reason', () => {
    renderWith(
      <MessageItem
        message={msg({
          id: 'm3',
          authorKind: 'system',
          meta: { kind: 'delegation', subagent: { tier: 'expert', model: 'claude-opus-5-5', effort: 'high', reason: 'Preuve mathématique délicate' } },
        })}
        bot={dev}
        bots={bots}
      />,
    );
    expect(screen.getByText(/délègue à un sous-agent expert/)).toBeTruthy();
    expect(screen.getByText('Opus 5.5')).toBeTruthy();
    expect(screen.getByText('Preuve mathématique délicate')).toBeTruthy();
  });

  it('shows a typing indicator for an empty streaming message', () => {
    renderWith(<MessageItem message={msg({ id: 'm4', status: 'streaming' })} bot={dev} bots={bots} />);
    expect(screen.getByLabelText('Réponse en cours')).toBeTruthy();
  });
});

describe('ApprovalCard', () => {
  it('posts the decision with the comment', async () => {
    const decided = approval({ id: 'a1', status: 'approved' });
    const fetchMock = mockFetch({ 'POST /api/approvals/a1/decide': decided });
    const { qc } = renderWith(<ApprovalCard approval={approval({ id: 'a1' })} bot={bot({ id: 'b1' })} />);
    qc.setQueryData(qk.approvals('pending'), [approval({ id: 'a1' })]);

    expect(screen.getByText('Envoyer un message en ton nom')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Commentaire pour le bot (facultatif)'), { target: { value: 'Ajoute la signature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approuver' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/approvals/a1/decide');
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'approve', comment: 'Ajoute la signature' });
    await waitFor(() => expect(qc.getQueryData(qk.approvals('pending'))).toEqual([]));
  });

  it('shows the result of a decided approval without buttons', () => {
    renderWith(<ApprovalCard approval={approval({ id: 'a2', status: 'executed', result: 'E-mail envoyé', decidedAt: '2026-10-12T10:05:00.000Z' })} bot={undefined} />);
    expect(screen.getByText('Exécutée')).toBeTruthy();
    expect(screen.getByText('E-mail envoyé')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approuver' })).toBeNull();
  });
});

describe('LoginPage', () => {
  it('goes from password to second factor and shows server errors', async () => {
    const fetchMock = mockFetch({
      '/api/auth/state': { setupRequired: false, authenticated: false, secondFactorPending: false, enrolmentPending: false, hasPasskey: false },
      'POST /api/auth/login': { next: 'second_factor' },
    });
    renderWith(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
      { route: '/login' },
    );
    const input = await screen.findByLabelText('Mot de passe');
    fireEvent.change(input, { target: { value: 'une phrase de passe très longue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    expect(await screen.findByLabelText('Code de vérification')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Utiliser un code de secours' }));
    expect(screen.getByLabelText('Code de secours')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Code de secours'), { target: { value: 'abcd-efgh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('second-factor')) as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toEqual({ recoveryCode: 'abcd-efgh' });
  });
});

describe('small renderers', () => {
  it('highlights search matches with <mark>', () => {
    const { container } = render(<Snippet text="le «devis» final" />);
    expect(container.querySelector('mark')?.textContent).toBe('devis');
  });

  it('draws one hit target per day in the usage chart', () => {
    const data = [
      { day: '2026-10-11', subscription: 1, api: 0.5 },
      { day: '2026-10-12', subscription: 0, api: 2 },
    ];
    render(<UsageChart data={data} metric="cost" />);
    expect(screen.getAllByLabelText(/abonnement .* crédits API/)).toHaveLength(2);
    expect(screen.getByRole('img', { name: /Consommation quotidienne/ })).toBeTruthy();
  });
});
