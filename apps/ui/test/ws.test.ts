import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ApprovalDTO, ComputerStatusDTO, MessageDTO, NudgeDTO, RunDTO } from '@ant/shared';
import { backoffDelay, wsUrl } from '../src/lib/ws';
import { dispatchServerEvent } from '../src/lib/ws-dispatch';
import { flattenMessages, type MessagePages, type ThreadData } from '../src/lib/cache';
import { qk } from '../src/lib/queries';
import { approval, msg, run } from './fixtures';

describe('backoff', () => {
  it('grows exponentially with jitter and is capped', () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(30_000);
    expect(backoffDelay(20, () => 0)).toBe(15_000);
  });

  it('derives the WebSocket URL from the page protocol', () => {
    expect(wsUrl('/api/ws', { protocol: 'https:', host: 'ant.example.ch' })).toBe('wss://ant.example.ch/api/ws');
    expect(wsUrl('/api/ws', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/ws');
  });
});

describe('dispatchServerEvent', () => {
  const setup = () => {
    const qc = new QueryClient();
    qc.setQueryData<MessagePages>(qk.messages('c1'), { pages: [[msg({ id: 'root' })]], pageParams: [null] });
    qc.setQueryData<ThreadData>(qk.thread('root'), { root: msg({ id: 'root' }), replies: [] });
    qc.setQueryData<RunDTO[]>(qk.activeRuns, []);
    return qc;
  };

  it('streams a bot reply: created → delta → updated', () => {
    const qc = setup();
    dispatchServerEvent(qc, { type: 'message.created', message: msg({ id: 'm1', status: 'streaming', createdAt: '2026-10-12T10:01:00.000Z' }) });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 'm1', channelId: 'c1', delta: 'Bon' });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 'm1', channelId: 'c1', delta: 'jour' });
    let list = flattenMessages(qc.getQueryData<MessagePages>(qk.messages('c1')));
    expect(list.map((m) => [m.id, m.content])).toEqual([
      ['root', ''],
      ['m1', 'Bonjour'],
    ]);
    dispatchServerEvent(qc, {
      type: 'message.updated',
      message: msg({ id: 'm1', status: 'done', content: 'Bonjour !', createdAt: '2026-10-12T10:01:00.000Z', meta: { model: 'claude-sonnet-5-5' } }),
    });
    list = flattenMessages(qc.getQueryData<MessagePages>(qk.messages('c1')));
    expect(list[1]).toMatchObject({ status: 'done', content: 'Bonjour !' });
  });

  it('routes replies to the thread and bumps the root counter', () => {
    const qc = setup();
    const reply = msg({ id: 'r1', threadRootId: 'root', createdAt: '2026-10-12T10:02:00.000Z' });
    dispatchServerEvent(qc, { type: 'message.created', message: reply });
    expect(qc.getQueryData<ThreadData>(qk.thread('root'))?.replies.map((r) => r.id)).toEqual(['r1']);
    const list = flattenMessages(qc.getQueryData<MessagePages>(qk.messages('c1')));
    expect(list).toHaveLength(1);
    expect(list[0]?.replyCount).toBe(1);
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 'r1', channelId: 'c1', delta: '…' });
    expect(qc.getQueryData<ThreadData>(qk.thread('root'))?.replies[0]?.content).toBe('…');
  });

  it('tracks active runs', () => {
    const qc = setup();
    dispatchServerEvent(qc, { type: 'run.updated', run: run({ id: 'r1', activity: 'utilise le terminal' }) });
    expect(qc.getQueryData<RunDTO[]>(qk.activeRuns)?.[0]?.activity).toBe('utilise le terminal');
    dispatchServerEvent(qc, { type: 'run.updated', run: run({ id: 'r1', status: 'done' }) });
    expect(qc.getQueryData<RunDTO[]>(qk.activeRuns)).toEqual([]);
  });

  it('updates approvals, computer status and nudges', () => {
    const qc = setup();
    qc.setQueryData<ApprovalDTO[]>(qk.approvals('pending'), [approval({ id: 'a1' })]);
    dispatchServerEvent(qc, { type: 'approval.updated', approval: approval({ id: 'a1', status: 'executed' }) });
    expect(qc.getQueryData<ApprovalDTO[]>(qk.approvals('pending'))).toEqual([]);

    const status: ComputerStatusDTO = { online: true, holder: 'user', since: '', activeBotId: null, lastAction: null, url: null };
    dispatchServerEvent(qc, { type: 'computer.updated', status });
    expect(qc.getQueryData(qk.computerStatus)).toEqual(status);

    qc.setQueryData<NudgeDTO[]>(qk.nudges(undefined, 10), []);
    qc.setQueryData<NudgeDTO[]>(qk.nudges('other-bot', 10), []);
    const nudge: NudgeDTO = { id: 'n1', botId: 'b1', kind: 'risque', title: 'Échéance', content: '', status: 'delivered', messageId: null, createdAt: '' };
    let seen: NudgeDTO | null = null;
    dispatchServerEvent(qc, { type: 'nudge.created', nudge }, { onNudge: (n) => (seen = n) });
    expect(qc.getQueryData<NudgeDTO[]>(qk.nudges(undefined, 10))).toHaveLength(1);
    expect(qc.getQueryData<NudgeDTO[]>(qk.nudges('other-bot', 10))).toHaveLength(0);
    expect(seen).toEqual(nudge);
  });

  it('invalidates on coarse events', () => {
    const qc = setup();
    qc.setQueryData(qk.quota, { stale: false });
    dispatchServerEvent(qc, { type: 'quota.updated' });
    expect(qc.getQueryState(qk.quota)?.isInvalidated).toBe(true);
  });
});

describe('dispatchServerEvent: message.updated of a message not loaded', () => {
  it('does not insert an old thread root into the newest page', () => {
    const qc = new QueryClient();
    const page = Array.from({ length: 50 }, (_, i) =>
      msg({ id: `n${i}`, createdAt: `2026-10-12T10:${String(10 + i).padStart(2, '0')}:00.000Z` }),
    );
    qc.setQueryData<MessagePages>(qk.messages('c1'), { pages: [page], pageParams: [null] });
    const before = qc.getQueryData<MessagePages>(qk.messages('c1'));
    // A reply in an old thread publishes message.updated for its root (createdAt 10:01, not loaded).
    dispatchServerEvent(qc, { type: 'message.updated', message: msg({ id: 'old-root', createdAt: '2026-10-12T10:01:00.000Z', replyCount: 3 }) });
    const after = qc.getQueryData<MessagePages>(qk.messages('c1'));
    expect(after).toBe(before);
    // The next page is still requested before the oldest message really loaded (10:10), not before the old root.
    expect(after?.pages[0]?.[0]?.createdAt).toBe('2026-10-12T10:10:00.000Z');
    expect(flattenMessages(after).some((m) => m.id === 'old-root')).toBe(false);
  });

  it('adds a reply whose message.created was lost while the conversation was being fetched', async () => {
    const qc = new QueryClient();
    let answer: (page: MessageDTO[]) => void = () => {};
    // The owner opens the conversation: the GET is in flight when the bot starts its reply.
    const fetching = qc.fetchInfiniteQuery({
      queryKey: qk.messages('c1'),
      initialPageParam: null as string | null,
      queryFn: () => new Promise<MessageDTO[]>((r) => (answer = r)),
    });
    const reply = msg({ id: 'reply', status: 'streaming', createdAt: '2026-10-12T10:05:00.000Z' });
    dispatchServerEvent(qc, { type: 'message.created', message: reply });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 'reply', channelId: 'c1', delta: 'Bon', offset: 0 });
    // The snapshot predates the reply.
    answer([msg({ id: 'older', createdAt: '2026-10-12T10:00:00.000Z' })]);
    await fetching;
    const ids = () => flattenMessages(qc.getQueryData<MessagePages>(qk.messages('c1'))).map((m) => m.id);
    expect(ids()).toEqual(['older']);
    dispatchServerEvent(qc, { type: 'message.updated', message: { ...reply, status: 'done', content: 'Bonjour' } });
    expect(ids()).toEqual(['older', 'reply']);
    expect(flattenMessages(qc.getQueryData<MessagePages>(qk.messages('c1')))[1]).toMatchObject({ status: 'done', content: 'Bonjour' });
  });

  it('adds a reply lost by a refetch that overwrote the cache', async () => {
    const qc = new QueryClient();
    const older = msg({ id: 'older', createdAt: '2026-10-12T10:00:00.000Z' });
    qc.setQueryData<MessagePages>(qk.messages('c1'), { pages: [[older]], pageParams: [null] });
    let answer: (page: MessageDTO[]) => void = () => {};
    const refetch = qc.fetchInfiniteQuery({
      queryKey: qk.messages('c1'),
      initialPageParam: null as string | null,
      queryFn: () => new Promise<MessageDTO[]>((r) => (answer = r)),
      staleTime: 0,
    });
    const reply = msg({ id: 'reply', status: 'streaming', createdAt: '2026-10-12T10:05:00.000Z' });
    dispatchServerEvent(qc, { type: 'message.created', message: reply });
    answer([older]);
    await refetch;
    dispatchServerEvent(qc, { type: 'message.updated', message: { ...reply, status: 'done', content: 'Fini' } });
    expect(flattenMessages(qc.getQueryData<MessagePages>(qk.messages('c1'))).map((m) => m.id)).toEqual(['older', 'reply']);
  });

  it('adds an updated message to a conversation that had none when it was fetched', () => {
    const qc = new QueryClient();
    qc.setQueryData<MessagePages>(qk.messages('c1'), { pages: [[]], pageParams: [null] });
    dispatchServerEvent(qc, { type: 'message.updated', message: msg({ id: 'first', content: 'Salut' }) });
    expect(flattenMessages(qc.getQueryData<MessagePages>(qk.messages('c1'))).map((m) => m.id)).toEqual(['first']);
  });

  it('still replaces a loaded message in place', () => {
    const qc = new QueryClient();
    qc.setQueryData<MessagePages>(qk.messages('c1'), { pages: [[msg({ id: 'a' }), msg({ id: 'b', createdAt: '2026-10-12T10:05:00.000Z' })]], pageParams: [null] });
    dispatchServerEvent(qc, { type: 'message.updated', message: msg({ id: 'a', content: 'modifié' }) });
    expect(flattenMessages(qc.getQueryData<MessagePages>(qk.messages('c1'))).map((m) => [m.id, m.content])).toEqual([
      ['a', 'modifié'],
      ['b', ''],
    ]);
  });
});

describe('dispatchServerEvent: run lists', () => {
  it('only refetches the run lists that can contain the run', () => {
    const qc = new QueryClient();
    qc.setQueryData<RunDTO[]>(qk.runs('bot-x', 15), [run({ id: 'x1', botId: 'bot-x' })]);
    qc.setQueryData<RunDTO[]>(qk.runs(undefined, 50), [run({ id: 'x1', botId: 'bot-x' })]);
    dispatchServerEvent(qc, { type: 'run.updated', run: run({ id: 'y1', botId: 'bot-y', activity: 'utilise le terminal' }) });
    expect(qc.getQueryState(qk.runs('bot-x', 15))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(qk.runs(undefined, 50))?.isInvalidated).toBe(true);

    dispatchServerEvent(qc, { type: 'run.updated', run: run({ id: 'x2', botId: 'bot-x', status: 'queued' }) });
    expect(qc.getQueryState(qk.runs('bot-x', 15))?.isInvalidated).toBe(true);
  });
});

describe('dispatchServerEvent: streamed chunks with offsets', () => {
  const setupStream = (id: string, content = '') => {
    const qc = new QueryClient();
    qc.setQueryData<MessagePages>(qk.messages('c1'), { pages: [[msg({ id, status: 'streaming', content })]], pageParams: [null] });
    return qc;
  };
  const text = (qc: QueryClient, id: string) => flattenMessages(qc.getQueryData<MessagePages>(qk.messages('c1'))).find((m) => m.id === id)?.content;

  it('applies chunks by offset and ignores a chunk already in the text', () => {
    const qc = setupStream('s1');
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's1', channelId: 'c1', delta: 'Bon', offset: 0 });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's1', channelId: 'c1', delta: 'jour', offset: 3 });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's1', channelId: 'c1', delta: 'jour', offset: 3 });
    expect(text(qc, 's1')).toBe('Bonjour');
  });

  it('fills back a text fetched from the database before the latest chunks were saved', () => {
    const qc = new QueryClient();
    // Conversation opened while the bot streams: the chunks arrive before the first fetch lands.
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's2', channelId: 'c1', delta: 'Voici ', offset: 0 });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's2', channelId: 'c1', delta: 'le plan ', offset: 6 });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's2', channelId: 'c1', delta: 'détaillé', offset: 14 });
    // The fetch returns the text saved a moment ago ("Voici "), then the next chunk arrives.
    qc.setQueryData<MessagePages>(qk.messages('c1'), { pages: [[msg({ id: 's2', status: 'streaming', content: 'Voici ' })]], pageParams: [null] });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's2', channelId: 'c1', delta: ' :', offset: 22 });
    expect(text(qc, 's2')).toBe('Voici le plan détaillé :');
    expect(qc.getQueryState(qk.messages('c1'))?.isInvalidated).toBe(false);
  });

  it('refetches (without restarting a fetch in flight) when text is missing, and never appends after the hole', () => {
    const qc = setupStream('s3', 'Début');
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    // Chunks 5..20 never reached this client (socket down): the next one starts at 20.
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's3', channelId: 'c1', delta: 'fin', offset: 20 });
    expect(text(qc, 's3')).toBe('Début');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.messages('c1'), exact: true }, { cancelRefetch: false });
    // Further chunks during the same burst do not trigger a refetch storm.
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's3', channelId: 'c1', delta: ' !', offset: 23 });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('starts over from a full version of the message (new attempt)', () => {
    const qc = setupStream('s4');
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's4', channelId: 'c1', delta: 'premier essai', offset: 0 });
    dispatchServerEvent(qc, { type: 'message.updated', message: msg({ id: 's4', status: 'streaming', content: 'Bonjour\n\n' }) });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 's4', channelId: 'c1', delta: 'suite', offset: 9 });
    expect(text(qc, 's4')).toBe('Bonjour\n\nsuite');
  });

  it('applies chunks to an open thread too', () => {
    const qc = new QueryClient();
    qc.setQueryData<ThreadData>(qk.thread('root'), { root: msg({ id: 'root' }), replies: [msg({ id: 'r9', threadRootId: 'root', status: 'streaming' })] });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 'r9', channelId: 'c1', delta: 'Oui', offset: 0 });
    dispatchServerEvent(qc, { type: 'message.delta', messageId: 'r9', channelId: 'c1', delta: 'Oui', offset: 0 });
    expect(qc.getQueryData<ThreadData>(qk.thread('root'))?.replies[0]?.content).toBe('Oui');
  });
});
