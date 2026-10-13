import { describe, expect, it } from 'vitest';
import { DEFAULT_SENSITIVE_DOMAINS, browserActionNeedsApproval, isNavigationKey } from '@ant/shared';

describe('sensitive-site key presses', () => {
  const d = DEFAULT_SENSITIVE_DOMAINS;

  it('gates every key that can send, submit or activate something', () => {
    for (const key of ['Enter', 'Control+Enter', 'Meta+Enter', 'Shift+Enter', 'NumpadEnter', 'Space', ' ', '\r', '\n', 'e', '#', 'l', 'Control+a', '']) {
      expect(browserActionNeedsApproval('press', 'https://x.com/compose/post', d, key), JSON.stringify(key)).toBe(true);
      expect(browserActionNeedsApproval('press', 'https://mail.google.com/mail/u/0/', d, key), JSON.stringify(key)).toBe(true);
    }
    expect(browserActionNeedsApproval('press', 'https://x.com/compose/post', d)).toBe(true);
  });

  it('leaves pure navigation keys free', () => {
    for (const key of ['Tab', 'Shift+Tab', 'shift + tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', 'Escape']) {
      expect(browserActionNeedsApproval('press', 'https://x.com/home', d, key), key).toBe(false);
      expect(isNavigationKey(key)).toBe(true);
    }
  });

  it('keeps the other rules unchanged', () => {
    expect(browserActionNeedsApproval('click', 'https://x.com/compose', d)).toBe(true);
    expect(browserActionNeedsApproval('type', 'https://x.com/compose', d)).toBe(false);
    expect(browserActionNeedsApproval('select', 'https://x.com/compose', d)).toBe(false);
    // Not a sensitive site: nothing is gated.
    expect(browserActionNeedsApproval('press', 'https://example.org/', d, 'Control+Enter')).toBe(false);
    expect(browserActionNeedsApproval('click', 'https://example.org/', d)).toBe(false);
  });
});
