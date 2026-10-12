import { memo, useMemo, type MouseEvent } from 'react';
import { renderMarkdown } from '../lib/markdown';
import { copyText } from '../lib/clipboard';
import { cx } from './ui';

function onClick(e: MouseEvent<HTMLDivElement>): void {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
  if (!btn) return;
  const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';
  void copyText(code).then((ok) => {
    btn.textContent = ok ? 'Copié' : 'Échec';
    setTimeout(() => {
      btn.textContent = 'Copier';
    }, 1500);
  });
}

export const Markdown = memo(function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  // Content is sanitized by DOMPurify in renderMarkdown.
  return <div className={cx('md', className)} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
