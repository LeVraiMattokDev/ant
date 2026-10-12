import { useId } from 'react';
import { cx } from '../ui';

/** The workspace mark in the icon rail: a soft honey-coloured gradient blob. */
export function WorkspaceMark({ size = 36, className }: { size?: number; className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={cx('shrink-0', className)} aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-a`} cx="30%" cy="22%" r="85%">
          <stop offset="0%" stopColor="#ffe08a" />
          <stop offset="45%" stopColor="#f2a93b" />
          <stop offset="100%" stopColor="#c9562a" />
        </radialGradient>
        <radialGradient id={`${id}-b`} cx="78%" cy="85%" r="55%">
          <stop offset="0%" stopColor="#ef6a8a" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#ef6a8a" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="12" fill={`url(#${id}-a)`} />
      <rect x="1" y="1" width="38" height="38" rx="12" fill={`url(#${id}-b)`} />
      <ellipse cx="14" cy="10" rx="9" ry="4.5" fill="#fff" opacity="0.28" />
    </svg>
  );
}
