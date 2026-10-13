import { describe, expect, it } from 'vitest';
import { SEARCH_MARK_END, SEARCH_MARK_START } from '@ant/shared';
import {
  appendDeltaToPages,
  appendDeltaToThread,
  applyApprovalUpdate,
  applyChannelMessageUpdate,
  applyRunUpdate,
  applyStreamChunks,
  bumpReplyCount,
  flattenMessages,
  parseSnippet,
  prependNudge,
  upsertChannelMessage,
  upsertThreadMessage,
  type MessagePages,
  type ThreadData,
} from '../src/lib/cache';
import { approval, msg, run } from './fixtures';

const pages = (...p: ReturnType<typeof msg>[][]): MessagePages => ({ pages: p, pageParams: p.map(() => null) });

describe('channel messages', () => {
  it('flattens pages chronologically (page 0 is the newest)', () => {
    const data = pages([msg({ id: 'c' }), msg({ id: 'd' })], [msg({ id: 'a' }), msg({ id: 'b' })]);
    expect(flattenMessages(data).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(flattenMessages(undefined)).toEqual([]);
  });

  it('appends a new top-level message to the newest page', () => {
    const data = pages([msg({ id: 'a' })]);
    const next = upsertChannelMessage(data, msg({ id: 'b', createdAt: '2026-10-12T11:00:00.000Z' }));
    expect(flattenMessages(next).map((m) => m.id)).toEqual(['a', 'b']);
    expect(data.pages[0]).toHaveLength(1); // input untouched
  });

  it('replaces an existing message instead of duplicating it', () => {
    const data = pages([msg({ id: 'a', content: 'old' })]);
    const next = upsertChannelMessage(data, msg({ id: 'a', content: 'new' }));
    expect(flattenMessages(next)).toHaveLength(1);
    expect(flattenMessages(next)[0]?.content).toBe('new');
  });

  it('ignores replies and missing caches', () => {
    const data = pages([msg({ id: 'a' })]);
    expect(upsertChannelMessage(data, msg({ id: 'r', threadRootId: 'a' }))).toBe(data);
    expect(upsertChannelMessage(undefined, msg({ id: 'x' }))).toBeUndefined();
  });

  it('keeps chronological order for out-of-order events', () => {
    const data = pages([msg({ id: 'b', createdAt: '2026-10-12T12:00:00.000Z' })]);
    const next = upsertChannelMessage(data, msg({ id: 'a', createdAt: '2026-10-12T11:00:00.000Z' }));
    expect(flattenMessages(next).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('applies a message update: in place when loaded, added inside the loaded window, never before it', () => {
    const t = (min: number) => `2026-10-12T10:${String(min).padStart(2, '0')}:00.000Z`;
    // Two pages loaded: 10:10–10:11 (older) and 10:20–10:21 (newest).
    const data = pages([msg({ id: 'n20', createdAt: t(20) }), msg({ id: 'n21', createdAt: t(21) })], [msg({ id: 'o10', createdAt: t(10) }), msg({ id: 'o11', createdAt: t(11) })]);
    const replaced = applyChannelMessageUpdate(data, msg({ id: 'o10', createdAt: t(10), content: 'modifié' }));
    expect(flattenMessages(replaced).map((m) => [m.id, m.content])).toEqual([
      ['o10', 'modifié'],
      ['o11', ''],
      ['n20', ''],
      ['n21', ''],
    ]);
    // Created after the fetch, its message.created lost: added to the newest page.
    expect(flattenMessages(applyChannelMessageUpdate(data, msg({ id: 'late', createdAt: t(22) }))).map((m) => m.id)).toEqual(['o10', 'o11', 'n20', 'n21', 'late']);
    // Older than everything loaded (an old thread root): left for its own page.
    expect(applyChannelMessageUpdate(data, msg({ id: 'old', createdAt: t(1) }))).toBe(data);
    // An empty trailing page does not hide the oldest loaded message.
    const withEmpty: MessagePages = { pages: [...data.pages, []], pageParams: [null, null, null] };
    expect(applyChannelMessageUpdate(withEmpty, msg({ id: 'old', createdAt: t(1) }))).toBe(withEmpty);
    // Nothing loaded at fetch time: every message is newer.
    expect(flattenMessages(applyChannelMessageUpdate(pages([]), msg({ id: 'first' }))).map((m) => m.id)).toEqual(['first']);
    expect(applyChannelMessageUpdate(data, msg({ id: 'r', threadRootId: 'n20', createdAt: t(30) }))).toBe(data);
    expect(applyChannelMessageUpdate(undefined, msg({ id: 'x' }))).toBeUndefined();
  });

  it('appends streamed deltas and returns the same reference when the message is unknown', () => {
    const data = pages([msg({ id: 'a', content: 'Bon', status: 'streaming' })]);
    const next = appendDeltaToPages(appendDeltaToPages(data, 'a', 'jo'), 'a', 'ur');
    expect(flattenMessages(next)[0]?.content).toBe('Bonjour');
    expect(appendDeltaToPages(data, 'zzz', 'x')).toBe(data);
  });

  it('bumps the reply count and last reply date of the thread root', () => {
    const data = pages([msg({ id: 'root', replyCount: 1, lastReplyAt: '2026-10-12T10:05:00.000Z' })]);
    const next = bumpReplyCount(data, msg({ id: 'r2', threadRootId: 'root', createdAt: '2026-10-12T10:10:00.000Z' }));
    const root = flattenMessages(next)[0];
    expect(root?.replyCount).toBe(2);
    expect(root?.lastReplyAt).toBe('2026-10-12T10:10:00.000Z');
  });
});

describe('threads', () => {
  const thread: ThreadData = { root: msg({ id: 'root', replyCount: 1 }), replies: [msg({ id: 'r1', threadRootId: 'root' })] };

  it('adds a reply once and keeps the count consistent', () => {
    const reply = msg({ id: 'r2', threadRootId: 'root', createdAt: '2026-10-12T10:01:00.000Z' });
    const once = upsertThreadMessage(thread, reply);
    const twice = upsertThreadMessage(once, reply);
    expect(twice?.replies.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(twice?.root.replyCount).toBe(2);
  });

  it('replaces the root and ignores replies of other threads', () => {
    expect(upsertThreadMessage(thread, msg({ id: 'root', content: 'edited' }))?.root.content).toBe('edited');
    expect(upsertThreadMessage(thread, msg({ id: 'x', threadRootId: 'other' }))).toBe(thread);
  });

  it('streams into a reply', () => {
    const next = appendDeltaToThread(thread, 'r1', 'abc');
    expect(next?.replies[0]?.content).toBe('abc');
    expect(appendDeltaToThread(thread, 'nope', 'x')).toBe(thread);
  });
});

describe('runs', () => {
  it('upserts active runs and removes finished ones', () => {
    const list = [run({ id: 'r1' })];
    const withNew = applyRunUpdate(list, run({ id: 'r2', status: 'queued' }));
    expect(withNew?.map((r) => r.id)).toEqual(['r1', 'r2']);
    const updated = applyRunUpdate(withNew, run({ id: 'r1', activity: 'utilise le navigateur' }));
    expect(updated?.[0]?.activity).toBe('utilise le navigateur');
    expect(applyRunUpdate(updated, run({ id: 'r1', status: 'done' }))?.map((r) => r.id)).toEqual(['r2']);
    expect(applyRunUpdate(list, run({ id: 'zz', status: 'cancelled' }))).toBe(list);
  });
});

describe('approvals', () => {
  it('removes decided approvals from the pending list but keeps them in the full list', () => {
    const pending = [approval({ id: 'a1' })];
    const decided = approval({ id: 'a1', status: 'approved' });
    expect(applyApprovalUpdate(pending, decided, true)).toEqual([]);
    expect(applyApprovalUpdate(pending, decided, false)?.[0]?.status).toBe('approved');
  });

  it('prepends new pending approvals', () => {
    const list = [approval({ id: 'a1' })];
    expect(applyApprovalUpdate(list, approval({ id: 'a2' }), true)?.map((a) => a.id)).toEqual(['a2', 'a1']);
  });
});

describe('nudges', () => {
  it('prepends without duplicates', () => {
    const n = { id: 'n1', botId: 'b1', kind: 'idee' as const, title: 't', content: 'c', status: 'delivered' as const, messageId: null, createdAt: '' };
    const list = prependNudge([], n);
    expect(prependNudge(list, n)).toBe(list);
    expect(list).toHaveLength(1);
  });
});

describe('search snippets', () => {
  const S = SEARCH_MARK_START;
  const E = SEARCH_MARK_END;

  it('splits the server marks into highlighted parts', () => {
    expect(parseSnippet(`Le ${S}devis${E} de ${S}Marie${E} est prêt`)).toEqual([
      { text: 'Le ', match: false },
      { text: 'devis', match: true },
      { text: ' de ', match: false },
      { text: 'Marie', match: true },
      { text: ' est prêt', match: false },
    ]);
    expect(parseSnippet('aucun marqueur')).toEqual([{ text: 'aucun marqueur', match: false }]);
  });

  it('leaves French « guillemets » in the text as written', () => {
    expect(parseSnippet(`Il a dit « ${S}oui${E} » hier`)).toEqual([
      { text: 'Il a dit « ', match: false },
      { text: 'oui', match: true },
      { text: ' » hier', match: false },
    ]);
  });
});

describe('streamed chunks', () => {
  it('applies chunks by offset, skips those already in the text and stops at a hole', () => {
    const chunks = [
      { offset: 0, delta: 'Bon' },
      { offset: 3, delta: 'jour' },
      { offset: 7, delta: ' à tous' },
    ];
    expect(applyStreamChunks('', chunks)).toEqual({ content: 'Bonjour à tous', gap: false });
    // Text fetched after the first two chunks were saved: nothing doubled.
    expect(applyStreamChunks('Bonjour', chunks)).toEqual({ content: 'Bonjour à tous', gap: false });
    // Text ahead of every chunk stays as is.
    expect(applyStreamChunks('Bonjour à tous !', chunks)).toEqual({ content: 'Bonjour à tous !', gap: false });
    // Text that misses a chunk: nothing is appended after the hole.
    expect(applyStreamChunks('Bon', [{ offset: 7, delta: ' à tous' }])).toEqual({ content: 'Bon', gap: true });
  });
});
