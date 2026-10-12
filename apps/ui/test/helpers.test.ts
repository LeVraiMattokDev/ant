import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageRowDTO } from '@ant/shared';
import { applyMention, filterMentionCandidates, mentionAtCaret } from '../src/components/chat/mentions';
import { bucketByDay, groupUsage, niceScale } from '../src/lib/usage';
import { renderMarkdown } from '../src/lib/markdown';
import { passwordStrength } from '../src/lib/password';
import { api, ApiError, buildUrl, setUnauthorizedHandler } from '../src/lib/api';
import { normaliseDomain } from '../src/components/settings/SensitiveDomains';
import { formatUsd } from '../src/lib/format';
import { bot } from './fixtures';

describe('mentions', () => {
  it('detects the mention being typed', () => {
    expect(mentionAtCaret('Salut @de', 9)).toEqual({ start: 6, query: 'de' });
    expect(mentionAtCaret('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAtCaret('mail@example', 12)).toBeNull();
    expect(mentionAtCaret('@dev fini', 9)).toBeNull();
  });

  it('ranks slug prefixes first and inserts the slug', () => {
    const bots = [bot({ id: '1', slug: 'recherche', name: 'Chercheuse' }), bot({ id: '2', slug: 'dev', name: 'Dev' })];
    expect(filterMentionCandidates(bots, 'de').map((b) => b.slug)).toEqual(['dev']);
    expect(filterMentionCandidates(bots, '').map((b) => b.slug)).toEqual(['recherche', 'dev']);
    expect(applyMention('Salut @de merci', { start: 6, query: 'de' }, 9, 'dev')).toEqual({ text: 'Salut @dev  merci', caret: 11 });
  });
});

describe('usage', () => {
  const row = (p: Partial<UsageRowDTO>): UsageRowDTO => ({
    day: '2026-10-12',
    botId: 'b1',
    model: 'claude-sonnet-5-5',
    computeSource: 'api',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.5,
    runs: 1,
    ...p,
  });

  it('fills every day and splits by compute source', () => {
    const today = new Date(2026, 9, 12, 15);
    const b = bucketByDay([row({}), row({ computeSource: 'subscription', costUsd: 0.25 }), row({ day: '2026-10-10' })], 3, 'cost', today);
    expect(b).toEqual([
      { day: '2026-10-10', subscription: 0, api: 0.5 },
      { day: '2026-10-11', subscription: 0, api: 0 },
      { day: '2026-10-12', subscription: 0.25, api: 0.5 },
    ]);
    expect(bucketByDay([row({})], 1, 'tokens', today)[0]?.api).toBe(150);
  });

  it('groups by key and sorts by total cost', () => {
    const g = groupUsage([row({ botId: 'a', costUsd: 1 }), row({ botId: 'b', costUsd: 3 }), row({ botId: 'a', computeSource: 'subscription', costUsd: 1 })], (r) => r.botId ?? '');
    expect(g.map((x) => [x.key, x.apiCostUsd, x.subscriptionCostUsd, x.runs])).toEqual([
      ['b', 3, 0, 1],
      ['a', 1, 1, 2],
    ]);
  });

  it('computes readable axis scales', () => {
    expect(niceScale(0)).toEqual({ max: 1, step: 0.25 });
    expect(niceScale(7.3)).toEqual({ max: 8, step: 2 });
    expect(niceScale(130)).toEqual({ max: 150, step: 50 });
  });
});

describe('markdown', () => {
  it('sanitizes HTML and renders code blocks with a copy button', () => {
    const html = renderMarkdown('Hello <img src=x onerror="alert(1)"> <script>alert(1)</script>\n\n```ts\nconst a = 1 < 2;\n```');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).toContain('data-copy-code');
    expect(html).toContain('const a = 1 &lt; 2;');
  });

  it('highlights mentions and opens links in a new tab', () => {
    const html = renderMarkdown('Merci @dev, voir [doc](https://example.com)');
    expect(html).toContain('<span class="mention">@dev</span>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('misc helpers', () => {
  it('rates passwords', () => {
    expect(passwordStrength('court').score).toBe(0);
    expect(passwordStrength('aaaaaaaaaaaaaaaa').score).toBe(1);
    expect(passwordStrength('cheval-agrafe-Batterie-42!').score).toBe(3);
  });

  it('normalises sensitive domains', () => {
    expect(normaliseDomain('https://www.Example.com/path')).toBe('www.example.com');
    expect(normaliseDomain('*.bank.ch')).toBe('bank.ch');
    expect(normaliseDomain('pas un domaine')).toBeNull();
  });

  it('formats costs', () => {
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(12)).toBe('$12.00');
  });

  it('builds query strings without empty values', () => {
    expect(buildUrl('/api/search', { q: 'été', botId: undefined, channelId: '' })).toBe('/api/search?q=%C3%A9t%C3%A9');
  });
});

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the CSRF header on mutations and parses JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/api/bots/1/heartbeat', { method: 'POST' })).resolves.toEqual({ ok: true });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['X-Requested-With']).toBe('ant');
    expect(init.credentials).toBe('include');
  });

  it('throws ApiError with the server message and calls the 401 handler outside /api/auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'rate_limited', message: 'Réessaie dans 12 minutes.' }), { status: 429 })));
    const err = await api('/api/auth/login', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Réessaie dans 12 minutes.');
    expect((err as ApiError).status).toBe(429);

    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized', message: 'Session expirée.' }), { status: 401 })));
    await api('/api/bots').catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await api('/api/auth/login/second-factor', { method: 'POST' }).catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
