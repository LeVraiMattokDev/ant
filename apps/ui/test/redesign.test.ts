import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ChannelDTO } from '@ant/shared';
import { AVATAR_COLORS, AVATAR_SHAPES, avatarSpec, hasCustomEmoji, hashString } from '../src/lib/avatar';
import { botLiveState, formatListTime, matchesQuery, previewText, stripMarkdown } from '../src/lib/preview';
import { applyBotPatch, effortDisplay, modelDisplayName, modelOptions, modelPatchFor, modelPillLabel } from '../src/lib/models';
import { applyLastMessage } from '../src/lib/cache';
import { dispatchServerEvent } from '../src/lib/ws-dispatch';
import { qk } from '../src/lib/queries';
import { placePanel } from '../src/components/Popover';
import { bot, msg, run } from './fixtures';

function channel(p: Partial<ChannelDTO> & { id: string }): ChannelDTO {
  return {
    kind: 'dm',
    name: 'Dev',
    topic: '',
    botIds: ['b1'],
    dmBotId: 'b1',
    lastMessageAt: null,
    lastMessage: null,
    lastReadAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...p,
  };
}

describe('generated avatars', () => {
  it('hashes deterministically (FNV-1a)', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('dev')).toBe(hashString('dev'));
    expect(hashString('dev')).not.toBe(hashString('dew'));
  });

  it('derives a stable creature from the slug', () => {
    const a = avatarSpec('xena');
    expect(avatarSpec('xena')).toEqual(a);
    expect(AVATAR_SHAPES).toContain(a.shape);
    expect(AVATAR_COLORS).toContain(a.color as (typeof AVATAR_COLORS)[number]);
    expect(['pill', 'dot', 'wide']).toContain(a.eyes);
    expect(a.eyeGap).toBeGreaterThanOrEqual(7);
    expect(a.eyeGap).toBeLessThanOrEqual(10);
    expect([-1, 0, 1]).toContain(a.eyeShift);
  });

  it('spreads shapes and colours over many slugs', () => {
    const specs = Array.from({ length: 300 }, (_, i) => avatarSpec(`bot-${i}`));
    expect(new Set(specs.map((s) => s.shape)).size).toBe(AVATAR_SHAPES.length);
    expect(new Set(specs.map((s) => s.color)).size).toBe(AVATAR_COLORS.length);
    // No shape dominates (uniform would be 50 each).
    for (const shape of AVATAR_SHAPES) expect(specs.filter((s) => s.shape === shape).length).toBeGreaterThan(25);
  });

  it('treats the default ant as "no custom emoji"', () => {
    expect(hasCustomEmoji('🐜')).toBe(false);
    expect(hasCustomEmoji(' 🐜 ')).toBe(false);
    expect(hasCustomEmoji('')).toBe(false);
    expect(hasCustomEmoji(null)).toBe(false);
    expect(hasCustomEmoji('🎧')).toBe(true);
  });
});

describe('conversation list helpers', () => {
  const now = new Date(2026, 9, 12, 18, 0);

  it('formats list times: today, yesterday, this year, older', () => {
    expect(formatListTime(new Date(2026, 9, 12, 17, 47).toISOString(), now)).toBe('17:47');
    expect(formatListTime(new Date(2026, 9, 11, 23, 19).toISOString(), now)).toBe('hier');
    expect(formatListTime(new Date(2026, 9, 3, 9, 0).toISOString(), now)).toBe('3 oct.');
    expect(formatListTime(new Date(2025, 2, 3, 9, 0).toISOString(), now)).toBe('3 mars 2025');
    expect(formatListTime(null, now)).toBe('');
    expect(formatListTime('pas une date', now)).toBe('');
  });

  it('strips markdown to a single preview line', () => {
    expect(stripMarkdown('Voici des **brouillons**.\n\n## Posts\n- *P1* : `kozmo`')).toBe('Voici des brouillons. Posts P1 : kozmo');
    expect(stripMarkdown('> citation\n\n[le lien](https://x.com) et ![img](a.png)')).toBe('citation le lien et img');
    expect(stripMarkdown('```ts\nconst a = 1;\n```\nfin')).toBe('const a = 1; fin');
    expect(stripMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a b 1 2');
    expect(stripMarkdown('snake_case et 2*3*4 restent')).toBe('snake_case et 2*3*4 restent');
    expect(stripMarkdown('<b>gras</b> ~~barré~~')).toBe('gras barré');
  });

  it('prefixes the owner and other bots in groups', () => {
    const bots = new Map([['b2', { name: 'Xena' }]]);
    const last = (p: Partial<NonNullable<ChannelDTO['lastMessage']>>) => ({
      content: 'Salut **toi**',
      authorKind: 'bot' as const,
      botId: 'b2',
      createdAt: '2026-10-12T10:00:00.000Z',
      ...p,
    });
    expect(previewText(channel({ id: 'c', lastMessage: null }), bots)).toBe('Aucun message pour le moment');
    expect(previewText(channel({ id: 'c', lastMessage: last({ authorKind: 'user', botId: null }) }), bots)).toBe('Toi : Salut toi');
    expect(previewText(channel({ id: 'c', lastMessage: last({}) }), bots)).toBe('Salut toi');
    expect(previewText(channel({ id: 'c', kind: 'group', lastMessage: last({}) }), bots)).toBe('Xena : Salut toi');
    expect(previewText(channel({ id: 'c', lastMessage: last({ content: '' }) }), bots)).toBe('…');
  });

  it('derives the live state of a bot', () => {
    const b = bot({ id: 'b1' });
    expect(botLiveState(b, [], 'dm1')).toBeNull();
    expect(botLiveState(b, [run({ id: 'r', channelId: 'dm1' })], 'dm1')).toEqual({ label: 'écrit…', tone: 'working' });
    expect(botLiveState(b, [run({ id: 'r', channelId: 'dm1', activity: 'Utilise le navigateur…' })], 'dm1')).toEqual({
      label: 'utilise le navigateur',
      tone: 'working',
    });
    expect(botLiveState({ ...b, activity: 'au travail' }, [run({ id: 'r', channelId: 'group' })], 'dm1')?.label).toBe('au travail');
    expect(botLiveState(b, [run({ id: 'r', status: 'waiting_approval' })], 'dm1')).toEqual({ label: 'attend ta validation', tone: 'waiting' });
    expect(botLiveState(b, [run({ id: 'r', status: 'queued' })], 'dm1')).toEqual({ label: 'en file d’attente', tone: 'waiting' });
    expect(botLiveState(b, [run({ id: 'r', botId: 'other' })], 'dm1')).toBeNull();
    expect(botLiveState({ ...b, activity: 'Rédige le rapport' }, undefined)).toEqual({ label: 'rédige le rapport', tone: 'working' });
  });

  it('matches the sidebar search without accents or case', () => {
    expect(matchesQuery('', 'Xena')).toBe(true);
    expect(matchesQuery('cafe', 'Café')).toBe(true);
    expect(matchesQuery('COMM', null, 'Community manager')).toBe(true);
    expect(matchesQuery('ops', 'Dev', 'Responsable du développement')).toBe(false);
  });
});

describe('model selector state', () => {
  it('labels models and efforts like the pill', () => {
    expect(modelDisplayName('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelDisplayName('claude-custom')).toBe('claude-custom');
    expect(effortDisplay('medium')).toBe('Moyen');
    expect(effortDisplay('xhigh')).toBe('Très élevé');
    expect(modelPillLabel('claude-haiku-5-5', 'high')).toBe('Claude Haiku 5.5 · Élevé');
  });

  it('keeps an unknown current model selectable', () => {
    expect(modelOptions('claude-sonnet-5-5')).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
    expect(modelOptions('claude-legacy')).toContain('claude-legacy');
  });

  it('sends only what changes', () => {
    const b = { model: 'claude-sonnet-5-5', effort: 'medium' as const };
    expect(modelPatchFor(b, { model: 'claude-sonnet-5-5' })).toBeNull();
    expect(modelPatchFor(b, { model: 'claude-opus-5-5' })).toEqual({ model: 'claude-opus-5-5' });
    expect(modelPatchFor(b, { effort: 'high' })).toEqual({ effort: 'high' });
  });

  it('patches the bots list optimistically', () => {
    const list = [bot({ id: 'b1' }), bot({ id: 'b2', slug: 'xena' })];
    const next = applyBotPatch(list, 'b2', { effort: 'max' });
    expect(next?.[1]?.effort).toBe('max');
    expect(next?.[0]).toBe(list[0]);
    expect(applyBotPatch(list, 'nope', { effort: 'max' })).toBe(list);
    expect(applyBotPatch(undefined, 'b1', {})).toBeUndefined();
  });
});

describe('channel previews in the cache', () => {
  const base = [channel({ id: 'c1', lastMessageAt: '2026-10-12T09:00:00.000Z' }), channel({ id: 'c2' })];

  it('sets the preview from a new top-level message', () => {
    const m = msg({ id: 'm1', channelId: 'c1', authorKind: 'user', botId: null, content: 'Bonjour', createdAt: '2026-10-12T10:00:00.000Z' });
    const next = applyLastMessage(base, m)!;
    expect(next[0]).toMatchObject({
      lastMessageAt: '2026-10-12T10:00:00.000Z',
      lastMessage: { content: 'Bonjour', authorKind: 'user', botId: null, createdAt: '2026-10-12T10:00:00.000Z' },
    });
    expect(next[1]).toBe(base[1]);
  });

  it('only bumps lastMessageAt for thread replies, and ignores older messages', () => {
    const reply = msg({ id: 'r', channelId: 'c1', threadRootId: 'root', createdAt: '2026-10-12T11:00:00.000Z' });
    const next = applyLastMessage(base, reply)!;
    expect(next[0]?.lastMessageAt).toBe('2026-10-12T11:00:00.000Z');
    expect(next[0]?.lastMessage).toBeNull();
    const withPreview = applyLastMessage(base, msg({ id: 'a', channelId: 'c1', content: 'récent', createdAt: '2026-10-12T12:00:00.000Z' }))!;
    const older = msg({ id: 'b', channelId: 'c1', content: 'ancien', createdAt: '2026-10-12T08:00:00.000Z' });
    expect(applyLastMessage(withPreview, older)).toBe(withPreview);
  });

  it('fills the streamed content of the same message on update', () => {
    const created = msg({ id: 's', channelId: 'c1', content: '', status: 'streaming', createdAt: '2026-10-12T10:00:00.000Z' });
    const a = applyLastMessage(base, created)!;
    const done = { ...created, content: 'Réponse complète', status: 'done' as const };
    const b = applyLastMessage(a, done, 'updated')!;
    expect(b[0]?.lastMessage?.content).toBe('Réponse complète');
    expect(applyLastMessage(b, done, 'updated')).toBe(b);
    // An update of an older message does not replace the preview.
    const old = msg({ id: 'o', channelId: 'c1', content: 'édité', createdAt: '2026-10-12T07:00:00.000Z' });
    expect(applyLastMessage(b, old, 'updated')).toBe(b);
  });

  it('is applied by the WebSocket dispatcher', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.channels, base);
    dispatchServerEvent(qc, { type: 'message.created', message: msg({ id: 'w', channelId: 'c2', content: 'Status: **done**', createdAt: '2026-10-12T10:00:00.000Z' }) });
    expect(qc.getQueryData<ChannelDTO[]>(qk.channels)?.[1]?.lastMessage?.content).toBe('Status: **done**');
    dispatchServerEvent(qc, {
      type: 'message.updated',
      message: msg({ id: 'w', channelId: 'c2', content: 'Status: **done**, PR envoyée', createdAt: '2026-10-12T10:00:00.000Z' }),
    });
    expect(qc.getQueryData<ChannelDTO[]>(qk.channels)?.[1]?.lastMessage?.content).toBe('Status: **done**, PR envoyée');
  });
});

describe('popover placement', () => {
  const vp = { width: 1000, height: 800 };
  const panel = { width: 200, height: 120 };

  it('places next to the trigger', () => {
    expect(placePanel({ top: 100, left: 10, right: 50, bottom: 140 }, panel, vp, 'right-start')).toEqual({ top: 100, left: 58 });
    expect(placePanel({ top: 100, left: 600, right: 640, bottom: 130 }, panel, vp, 'bottom-end')).toEqual({ top: 138, left: 440 });
  });

  it('flips and clamps inside the viewport', () => {
    expect(placePanel({ top: 740, left: 100, right: 140, bottom: 770 }, panel, vp, 'bottom-start')).toEqual({ top: 612, left: 100 });
    expect(placePanel({ top: 20, left: 950, right: 990, bottom: 50 }, panel, vp, 'top-start')).toEqual({ top: 58, left: 792 });
    expect(placePanel({ top: 760, left: 10, right: 50, bottom: 790 }, panel, vp, 'right-end').top).toBe(670);
  });
});
