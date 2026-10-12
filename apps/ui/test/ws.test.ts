import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ApprovalDTO, ComputerStatusDTO, NudgeDTO, RunDTO } from '@ant/shared';
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
