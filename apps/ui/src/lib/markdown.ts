import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface MentionToken extends Tokens.Generic {
  type: 'mention';
  raw: string;
  slug: string;
}

const mention: TokenizerAndRendererExtension = {
  name: 'mention',
  level: 'inline',
  start(src: string) {
    const i = src.search(/(^|[\s(])@[a-z0-9]/i);
    if (i < 0) return undefined;
    return src[i] === '@' ? i : i + 1;
  },
  tokenizer(src: string): MentionToken | undefined {
    // '_' belongs to handles (X, GitHub…); '.' does not: it would swallow the period ending a sentence.
    const m = /^@([a-z0-9][a-z0-9_-]{0,39})/i.exec(src);
    if (!m) return undefined;
    return { type: 'mention', raw: m[0], slug: (m[1] ?? '').toLowerCase() };
  },
  renderer(token) {
    // Shows the text exactly as written: tweet drafts and approval summaries are checked word for word.
    return `<span class="mention">${escapeHtml(String((token as MentionToken).raw))}</span>`;
  },
};

const md = new Marked({
  gfm: true,
  breaks: true,
  extensions: [mention],
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? '').split(/\s/)[0] ?? '';
      const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : '<span class="code-lang"></span>';
      return `<div class="code-block"><div class="code-head">${label}<button type="button" class="code-copy" data-copy-code="1">Copier</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`;
    },
  },
});

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node instanceof Element && node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Markdown → sanitized HTML (GFM, line breaks, @mentions, code blocks with a copy button). */
export function renderMarkdown(src: string): string {
  ensureHooks();
  const html = md.parse(src ?? '', { async: false });
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-copy-code'],
    FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
  });
}
