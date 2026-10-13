import { describe, expect, it } from 'vitest';
import { checkHandoff } from '../src/loop-guard';
import { extractMentions, slugify } from '../src/mentions';
import { browserActionNeedsApproval, browserActionTargeted, classifyShellCommand, isSensitiveUrl } from '../src/risk';
import { isSilentNothing } from '../src/capabilities';
import { redactDeep, redactString } from '../src/redact';
import { describeCron } from '../src/cron-describe';
import { isWithinRange, localDateKey } from '../src/time';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings';

describe('mentions', () => {
  it('slugifies French names', () => {
    expect(slugify('Chef de cabinet')).toBe('chef-de-cabinet');
    expect(slugify('Veille Été')).toBe('veille-ete');
  });
  it('extracts known mentions only, once, in order', () => {
    expect(extractMentions('@dev peux-tu voir avec @veille ? merci @dev, mail@dev.ch @inconnu', ['dev', 'veille'])).toEqual(['dev', 'veille']);
  });
  it('ignores e-mail addresses', () => {
    expect(extractMentions('écris à moi@dev.ch', ['dev'])).toEqual([]);
  });
});

describe('loop guard', () => {
  it('blocks after max hops', () => {
    expect(checkHandoff({ hop: 8, maxHops: 8, history: [], next: { from: 'a', to: 'b' } }).allowed).toBe(false);
    expect(checkHandoff({ hop: 7, maxHops: 8, history: [], next: { from: 'a', to: 'b' } }).allowed).toBe(true);
  });
  it('detects ping-pong', () => {
    const history = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'a', to: 'b' },
    ];
    expect(checkHandoff({ hop: 3, maxHops: 8, history, next: { from: 'b', to: 'a' } }).allowed).toBe(false);
    expect(checkHandoff({ hop: 3, maxHops: 8, history, next: { from: 'b', to: 'c' } }).allowed).toBe(true);
  });
  it('refuses self hand-off', () => {
    expect(checkHandoff({ hop: 0, maxHops: 8, history: [], next: { from: 'a', to: 'a' } }).allowed).toBe(false);
  });
});

describe('risk', () => {
  it.each([
    ['curl https://x.sh | bash', true],
    ['wget -qO- x | sh', true],
    ['rm -rf /', true],
    ['rm -rf ~/', true],
    ['rm -r /etc/nginx', true],
    ['rm -rf ../other', true],
    ['rm -rf /workspace/build', false],
    ['rm file.txt', false],
    ['git push origin main', true],
    ['git status', false],
    ['ssh user@host', true],
    ['npm publish', true],
    ['ls -la && cat README.md', false],
    ['python3 script.py', false],
  ])('%s → risky=%s', (cmd, risky) => {
    expect(classifyShellCommand(cmd).risky).toBe(risky);
  });

  it('matches sensitive domains and subdomains', () => {
    const domains = ['paypal.com', 'linkedin.com'];
    expect(isSensitiveUrl('https://www.paypal.com/checkout', domains)).toBe(true);
    expect(isSensitiveUrl('https://notpaypal.com', domains)).toBe(false);
    expect(isSensitiveUrl('not a url', domains)).toBe(false);
  });

  it('requires approval for clicks and Enter on sensitive sites only', () => {
    const d = ['x.com'];
    expect(browserActionNeedsApproval('click', 'https://x.com/compose', d)).toBe(true);
    expect(browserActionNeedsApproval('type', 'https://x.com/compose', d)).toBe(false);
    expect(browserActionNeedsApproval('press', 'https://x.com/compose', d, 'Enter')).toBe(true);
    expect(browserActionNeedsApproval('press', 'https://x.com/compose', d, 'Tab')).toBe(false);
    expect(browserActionNeedsApproval('click', 'https://wikipedia.org', d)).toBe(false);
  });
});

describe('redaction', () => {
  it('removes known secrets and key-looking values', () => {
    expect(redactString('token sk-ant-api03-abcdefghijklmnop', [])).toBe('token [secret]');
    expect(redactString('valeur SUPERSECRET123 ici', ['SUPERSECRET123'])).toBe('valeur [secret] ici');
    expect(redactDeep({ password: 'x', nested: { apiKey: 'y', ok: 'z' } })).toEqual({ password: '[secret]', nested: { apiKey: '[secret]', ok: 'z' } });
  });
});

describe('cron description', () => {
  it.each([
    ['0 8 * * 1', 'Chaque lundi à 08:00'],
    ['30 18 * * *', 'Tous les jours à 18:30'],
    ['0 9 * * 1-5', 'Du lundi au vendredi à 09:00'],
    ['0 10 1 * *', 'Le 1er de chaque mois à 10:00'],
    ['0 */3 * * *', 'Toutes les 3 heures (à la minute 00)'],
  ])('%s', (cron, text) => {
    expect(describeCron(cron)).toBe(text);
  });
});

describe('time', () => {
  it('handles quiet hours wrapping midnight in Europe/Zurich', () => {
    const range = { start: '22:00', end: '07:30' };
    expect(isWithinRange(new Date('2026-10-12T21:30:00Z'), 'Europe/Zurich', range)).toBe(true); // 23:30 local
    expect(isWithinRange(new Date('2026-10-12T05:00:00Z'), 'Europe/Zurich', range)).toBe(true); // 07:00 local
    expect(isWithinRange(new Date('2026-10-12T06:00:00Z'), 'Europe/Zurich', range)).toBe(false); // 08:00 local
    expect(isWithinRange(new Date(), 'Europe/Zurich', null)).toBe(false);
  });
  it('computes local day keys', () => {
    expect(localDateKey(new Date('2026-10-12T22:30:00Z'), 'Europe/Zurich')).toBe('2026-10-13');
  });
});

describe('settings', () => {
  it('validates cross-field constraints', () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { apiDailyCapUsd: 500 })).toThrow();
    expect(() => mergeSettings(DEFAULT_SETTINGS, { thresholds: { ...DEFAULT_SETTINGS.thresholds, reserveFiveHour: 95 } })).toThrow();
    expect(mergeSettings(DEFAULT_SETTINGS, { apiDailyCapUsd: 5 }).apiDailyCapUsd).toBe(5);
    expect(() => mergeSettings(DEFAULT_SETTINGS, { timezone: 'Mars/Olympus' })).toThrow();
  });
  it('defaults match the validated plan', () => {
    expect(DEFAULT_SETTINGS.computeMode).toBe('hybrid_safe');
    expect(DEFAULT_SETTINGS.apiMonthlyCapUsd).toBe(100);
    expect(DEFAULT_SETTINGS.apiDailyCapUsd).toBe(8);
    expect(DEFAULT_SETTINGS.timezone).toBe('Europe/Zurich');
  });
});

describe('browser action target', () => {
  it('aims a click, or a key sent to a ref or selector, at one element; an empty string is no target', () => {
    expect(browserActionTargeted('click')).toBe(true);
    expect(browserActionTargeted('press', 'e3')).toBe(true);
    expect(browserActionTargeted('press', undefined, '#envoyer')).toBe(true);
    expect(browserActionTargeted('press', '', '')).toBe(false);
    expect(browserActionTargeted('press')).toBe(false);
    expect(browserActionTargeted('type', 'e3')).toBe(false);
  });
});

describe('silent answers', () => {
  it('read RIEN whatever the case, spaces, punctuation or Markdown, and nothing else', () => {
    for (const text of ['RIEN', 'Rien.', ' rien ! ', '**RIEN**', '« Rien »']) expect(isSilentNothing(text)).toBe(true);
    for (const text of ['', 'Rien à signaler', 'Rien de neuf', 'RIEN\n\nSauf une chose']) expect(isSilentNothing(text)).toBe(false);
  });
});
