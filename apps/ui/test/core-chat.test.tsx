import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ApprovalDTO, BotDTO, ChannelDTO, MessageDTO, QuotaStatusDTO, RunDTO } from '@ant/shared';
import { ConfirmProvider } from '../src/components/Modal';
import { Composer } from '../src/components/chat/Composer';
import { ActivityBar } from '../src/components/chat/ActivityBar';
import { ChannelSettingsModal } from '../src/components/chat/ChannelSettingsModal';
import { MessageList } from '../src/components/chat/MessageList';
import { SystemMessage } from '../src/components/chat/SystemMessage';
import { ThreadPane } from '../src/components/chat/ThreadPane';
import { draftKey, getDraft, setDraft } from '../src/components/chat/useSendMessage';
import { ShellContext } from '../src/components/layout/shell';
import { flattenMessages, type MessagePages, type ThreadData } from '../src/lib/cache';
import { TOUCH_QUERY } from '../src/lib/hooks';
import { qk, useChannels } from '../src/lib/queries';
import { useToasts } from '../src/lib/toast';
import { dispatchServerEvent } from '../src/lib/ws-dispatch';
import { approval, bot, msg, run } from './fixtures';

type Handler = (method: string, path: string, body: unknown) => Promise<{ status?: number; body: unknown } | undefined> | { status?: number; body: unknown } | undefined;

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

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

function Providers({ qc, children }: { qc: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ConfirmProvider>{children}</ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function channel(p: Partial<ChannelDTO> & { id: string }): ChannelDTO {
  return {
    kind: 'group',
    name: 'projet',
    topic: '',
    botIds: ['b1'],
    dmBotId: null,
    lastMessageAt: null,
    lastMessage: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...p,
  };
}

function ToastProbe() {
  const toasts = useToasts();
  return <output data-testid="toasts">{toasts.map((t) => t.title).join('|')}</output>;
}

const readMarks = (): Record<string, string> => JSON.parse(localStorage.getItem('ant-last-read') ?? '{}') as Record<string, string>;

const realMatchMedia = window.matchMedia;
afterEach(() => {
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
});

describe('sending a message, then switching conversation before the answer', () => {
  it('keeps the message in its own conversation and leaves the other draft alone', async () => {
    const qc = newClient();
    qc.setQueryData<MessagePages>(qk.messages('chA'), { pages: [[msg({ id: 'a0', channelId: 'chA' })]], pageParams: [null] });
    qc.setQueryData<MessagePages>(qk.messages('chB'), { pages: [[msg({ id: 'b0', channelId: 'chB' })]], pageParams: [null] });
    setDraft(draftKey('chB', null), 'brouillon pour B');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const sent: MessageDTO = msg({ id: 'sent', channelId: 'chA', authorKind: 'user', botId: null, content: 'hello', createdAt: '2026-10-12T11:00:00.000Z' });
    const fetchMock = mockFetch(async (method, path) => {
      if (method === 'POST' && path === '/api/channels/chA/messages') {
        await gate;
        return { body: { message: sent, runs: [] } };
      }
      return undefined;
    });

    const view = (channelId: string) => (
      <Providers qc={qc}>
        <Composer channelId={channelId} members={[]} placeholder="Écrire…" autoFocus={false} />
      </Providers>
    );
    const { rerender } = render(view('chA'));
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The owner opens conversation B while the POST is still on its way.
    rerender(view('chB'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('brouillon pour B');

    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(flattenMessages(qc.getQueryData<MessagePages>(qk.messages('chA'))).map((m) => m.id)).toEqual(['a0', 'sent']));
    expect(flattenMessages(qc.getQueryData<MessagePages>(qk.messages('chB'))).map((m) => m.id)).toEqual(['b0']);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('brouillon pour B');
    expect(getDraft(draftKey('chB', null))).toBe('brouillon pour B');
    expect(getDraft(draftKey('chA', null))).toBe('');
    expect(readMarks().chA).toBe('2026-10-12T11:00:00.000Z');
    expect(readMarks().chB).toBeUndefined();
  });

  /** Composer per conversation, POSTs held until the test answers them. */
  function concurrentSends() {
    const qc = newClient();
    const answers = new Map<string, (res: { status?: number; body: unknown }) => void>();
    const fetchMock = mockFetch((method, path) => {
      const m = /^\/api\/channels\/([^/]+)\/messages$/.exec(path);
      if (method !== 'POST' || !m) return undefined;
      return new Promise((resolve) => answers.set(m[1]!, resolve));
    });
    const view = (channelId: string) => (
      <Providers qc={qc}>
        <Composer channelId={channelId} members={[]} placeholder="Écrire…" autoFocus={false} />
        <ToastProbe />
      </Providers>
    );
    const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
    const sendButton = () => screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement;
    const type = (value: string) => {
      fireEvent.change(box(), { target: { value } });
      fireEvent.keyDown(box(), { key: 'Enter' });
    };
    const answer = async (channelId: string, res: { status?: number; body: unknown }) => {
      await waitFor(() => expect(answers.has(channelId)).toBe(true));
      await act(async () => {
        answers.get(channelId)!(res);
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    return { qc, fetchMock, view, box, sendButton, type, answer };
  }

  it('reports the failure of A after a message was sent in B meanwhile', async () => {
    const t = concurrentSends();
    const { rerender } = render(t.view('chE1'));
    t.type('message pour A');
    await waitFor(() => expect(t.fetchMock).toHaveBeenCalledTimes(1));
    rerender(t.view('chE2'));
    t.type('message pour B');
    await waitFor(() => expect(t.fetchMock).toHaveBeenCalledTimes(2));
    await t.answer('chE1', { status: 500, body: { error: 'internal', message: 'Erreur interne du serveur.' } });
    await waitFor(() => expect(screen.getByTestId('toasts').textContent).toContain('Message non envoyé'));
    // A's text stays in its draft, so the owner finds it again.
    expect(getDraft(draftKey('chE1', null))).toBe('message pour A');
    await t.answer('chE2', { body: { message: msg({ id: 'e2', channelId: 'chE2', authorKind: 'user', botId: null, content: 'message pour B' }), runs: [] } });
    expect(t.box().value).toBe('');
  });

  it('back in A while its send is still pending: blocked, then emptied when it lands', async () => {
    const t = concurrentSends();
    const { rerender } = render(t.view('chF1'));
    t.type('bonjour A');
    await waitFor(() => expect(t.fetchMock).toHaveBeenCalledTimes(1));
    rerender(t.view('chF2'));
    t.type('bonjour B');
    await waitFor(() => expect(t.fetchMock).toHaveBeenCalledTimes(2));
    rerender(t.view('chF1'));
    expect(t.box().value).toBe('bonjour A');
    // A is still on its way: sending it again would post it twice.
    expect(t.sendButton().disabled).toBe(true);
    fireEvent.keyDown(t.box(), { key: 'Enter' });
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    await t.answer('chF1', { body: { message: msg({ id: 'f1', channelId: 'chF1', authorKind: 'user', botId: null, content: 'bonjour A' }), runs: [] } });
    await waitFor(() => expect(t.box().value).toBe(''));
    expect(getDraft(draftKey('chF1', null))).toBe('');
    // B is untouched: its draft waits for its own answer.
    expect(getDraft(draftKey('chF2', null))).toBe('bonjour B');
  });

  it('does not show the pending send of A as blocking B', async () => {
    const qc = newClient();
    mockFetch(() => new Promise(() => {}));
    const view = (channelId: string) => (
      <Providers qc={qc}>
        <Composer channelId={channelId} members={[]} placeholder="Écrire…" autoFocus={false} />
      </Providers>
    );
    const { rerender } = render(view('chP'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'en route' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement).disabled).toBe(true));
    rerender(view('chQ'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'autre chose' } });
    expect((screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Composer on a touch screen', () => {
  beforeEach(() => {
    window.matchMedia = ((query: string) =>
      ({
        matches: query === TOUCH_QUERY,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia;
  });

  it('lets Enter add a line and sends with the button (or Ctrl+Enter)', async () => {
    const qc = newClient();
    const fetchMock = mockFetch((method, path) =>
      method === 'POST' && path === '/api/channels/chT/messages'
        ? { body: { message: msg({ id: 't1', channelId: 'chT', authorKind: 'user', botId: null }), runs: [] } }
        : undefined,
    );
    render(
      <Providers qc={qc}>
        <Composer channelId="chT" members={[]} placeholder="Écrire…" autoFocus={false} />
      </Providers>,
    );
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.getAttribute('enterkeyhint')).toBe('enter');
    fireEvent.change(box, { target: { value: 'Ligne 1' } });
    // Not prevented: the browser inserts the newline.
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe('approval messages', () => {
  const bots = new Map<string, BotDTO>([['b1', bot({ id: 'b1' })]]);

  it('shows the card under the request only; an outcome notice is not a new request', () => {
    const qc = newClient();
    qc.setQueryData<ApprovalDTO[]>(qk.approvals('all'), [approval({ id: 'a1', status: 'rejected' })]);
    const outcome = msg({ id: 'o1', authorKind: 'system', botId: null, content: '🚫 Validation « Envoyer » refusée.', meta: { kind: 'approval', approvalId: 'a1' } });
    const { container, unmount } = render(
      <Providers qc={qc}>
        <SystemMessage message={outcome} bots={bots} />
      </Providers>,
    );
    expect(screen.queryByText(/Validation demandée/)).toBeNull();
    expect(screen.getByText('Validation')).toBeTruthy();
    expect(container.querySelector('#approval-a1')).toBeNull();
    unmount();

    const request = msg({ id: 'q1', authorKind: 'system', botId: 'b1', content: 'Je dois envoyer un e-mail.', meta: { kind: 'approval', approvalId: 'a1', runId: 'r1' } });
    const r = render(
      <Providers qc={qc}>
        <SystemMessage message={request} bots={bots} />
      </Providers>,
    );
    expect(screen.getByText('Validation demandée par Dev')).toBeTruthy();
    expect(r.container.querySelector('#approval-a1')).not.toBeNull();
  });

  it('fetches an approval older than the list instead of calling it missing', async () => {
    const qc = newClient();
    qc.setQueryData<ApprovalDTO[]>(qk.approvals('all'), [approval({ id: 'recent' })]);
    mockFetch((method, path) =>
      method === 'GET' && path === '/api/approvals/a-old' ? { body: approval({ id: 'a-old', title: 'Publier le billet', status: 'executed' }) } : undefined,
    );
    const request = msg({ id: 'q2', authorKind: 'system', botId: 'b1', meta: { kind: 'approval', approvalId: 'a-old', runId: 'r1' } });
    const { container } = render(
      <Providers qc={qc}>
        <SystemMessage message={request} bots={bots} />
      </Providers>,
    );
    await waitFor(() => expect(container.querySelector('#approval-a-old')).not.toBeNull());
    expect(screen.queryByText(/introuvable/)).toBeNull();
  });
});

describe('MessageList', () => {
  const bots = new Map<string, BotDTO>();

  it('marks thread replies read: the channel stops showing as unread', async () => {
    const qc = newClient();
    qc.setQueryData<ChannelDTO[]>(qk.channels, [channel({ id: 'chR', lastMessageAt: '2026-10-12T10:06:00.000Z' })]);
    qc.setQueryData<MessagePages>(qk.messages('chR'), {
      pages: [[msg({ id: 'top', channelId: 'chR', createdAt: '2026-10-12T10:05:00.000Z', replyCount: 1 })]],
      pageParams: [null],
    });
    render(
      <Providers qc={qc}>
        <MessageList channelId="chR" bots={bots} empty={null} />
      </Providers>,
    );
    // The bot's reply in the thread (10:06) is newer than the last top-level message (10:05).
    await waitFor(() => expect(readMarks().chR).toBe('2026-10-12T10:06:00.000Z'));
  });

  it('scrolls to a deep-linked message once, not again on every streamed chunk', async () => {
    const scroll = vi.fn();
    const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scroll;
    try {
      const qc = newClient();
      qc.setQueryData<ChannelDTO[]>(qk.channels, [channel({ id: 'chF' })]);
      qc.setQueryData<MessagePages>(qk.messages('chF'), {
        pages: [[msg({ id: 'target', channelId: 'chF', content: 'ici' }), msg({ id: 'live', channelId: 'chF', status: 'streaming', createdAt: '2026-10-12T10:09:00.000Z' })]],
        pageParams: [null],
      });
      render(
        <Providers qc={qc}>
          <MessageList channelId="chF" bots={bots} focusMessageId="target" empty={null} />
        </Providers>,
      );
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      for (const delta of ['Bon', 'jour', ' !']) {
        act(() => dispatchServerEvent(qc, { type: 'message.delta', messageId: 'live', channelId: 'chF', delta }));
      }
      act(() =>
        dispatchServerEvent(qc, { type: 'message.created', message: msg({ id: 'new', channelId: 'chF', createdAt: '2026-10-12T10:10:00.000Z' }) }),
      );
      await waitFor(() => expect(screen.getByText('Bonjour !')).toBeTruthy());
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally {
      proto.scrollIntoView = original;
    }
  });
});

describe('ChannelSettingsModal', () => {
  function Harness() {
    const ch = useChannels().data?.find((c) => c.id === 'chS');
    return ch ? <ChannelSettingsModal channel={ch} open onClose={() => {}} /> : null;
  }

  it('keeps what the owner types when a message arrives in the channel', async () => {
    const qc = newClient();
    qc.setQueryData<ChannelDTO[]>(qk.channels, [channel({ id: 'chS', name: 'projet' })]);
    qc.setQueryData(qk.bots, [bot({ id: 'b1' })]);
    render(
      <Providers qc={qc}>
        <Harness />
      </Providers>,
    );
    const name = screen.getByLabelText('Nom') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'nouveau nom' } });
    act(() =>
      dispatchServerEvent(qc, { type: 'message.created', message: msg({ id: 'x', channelId: 'chS', content: 'Bonjour', createdAt: '2026-10-12T12:00:00.000Z' }) }),
    );
    await waitFor(() => expect(qc.getQueryData<ChannelDTO[]>(qk.channels)?.[0]?.lastMessageAt).toBe('2026-10-12T12:00:00.000Z'));
    await new Promise((r) => setTimeout(r, 30));
    expect((screen.getByLabelText('Nom') as HTMLInputElement).value).toBe('nouveau nom');
  });
});

describe('ThreadPane next to the computer panel', () => {
  const renderPane = (computerOpen: boolean) => {
    const qc = newClient();
    qc.setQueryData<ThreadData>(qk.thread('root'), { root: msg({ id: 'root' }), replies: [] });
    qc.setQueryData<RunDTO[]>(qk.activeRuns, []);
    return render(
      <Providers qc={qc}>
        <ShellContext.Provider value={{ openNewChannel: () => {}, openFiles: () => {}, toggleComputer: () => {}, computerOpen }}>
          <ThreadPane channelId="c1" rootId="root" bots={new Map()} members={[]} onClose={() => {}} />
        </ShellContext.Provider>
      </Providers>,
    );
  };

  it('stays an overlay while the computer is docked, so the conversation keeps its width', () => {
    renderPane(true);
    expect(screen.getByRole('region', { name: 'Fil de discussion' }).className).not.toContain('xl:static');
  });

  it('docks beside the conversation otherwise', () => {
    renderPane(false);
    expect(screen.getByRole('region', { name: 'Fil de discussion' }).className).toContain('xl:static');
  });
});

describe('ActivityBar when the worker is down', () => {
  const quota = (worker?: QuotaStatusDTO['worker']) => ({ allPaused: false, pausedReason: null, ...(worker ? { worker } : {}) }) as unknown as QuotaStatusDTO;
  const bots = new Map<string, BotDTO>([['b1', bot({ id: 'b1', name: 'Content' })]]);

  it('says why a queued run does not start', () => {
    const qc = newClient();
    qc.setQueryData<RunDTO[]>(qk.activeRuns, [run({ id: 'q1', status: 'queued' })]);
    qc.setQueryData(qk.quota, quota({ lastSeenAt: '2026-10-12T09:00:00.000Z', alive: false }));
    render(
      <Providers qc={qc}>
        <ActivityBar channelId="c1" bots={bots} />
      </Providers>,
    );
    expect(screen.getByText('Content attend le worker')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Le worker ne répond pas');
  });

  it('keeps the usual label when the worker is alive or not reported', () => {
    for (const worker of [{ lastSeenAt: '2026-10-12T09:00:00.000Z', alive: true }, undefined]) {
      const qc = newClient();
      qc.setQueryData<RunDTO[]>(qk.activeRuns, [run({ id: 'q1', status: 'queued' })]);
      qc.setQueryData(qk.quota, quota(worker));
      const { unmount } = render(
        <Providers qc={qc}>
          <ActivityBar channelId="c1" bots={bots} />
        </Providers>,
      );
      expect(screen.getByText('Content est en file d’attente')).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
      unmount();
    }
  });
});
