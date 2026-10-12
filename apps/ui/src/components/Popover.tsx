import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { cx } from './ui';

export type Placement = 'right-start' | 'right-end' | 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface TriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  'aria-expanded': boolean;
  'aria-haspopup': 'menu' | 'dialog';
  'aria-controls': string | undefined;
}

const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"])';

/** Position of a panel next to its trigger, kept inside the viewport (8 px margin). */
export function placePanel(
  rect: { top: number; left: number; right: number; bottom: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: Placement,
  offset = 8,
): { top: number; left: number } {
  let top: number;
  let left: number;
  switch (placement) {
    case 'right-start':
      left = rect.right + offset;
      top = rect.top;
      break;
    case 'right-end':
      left = rect.right + offset;
      top = rect.bottom - panel.height;
      break;
    case 'bottom-start':
      left = rect.left;
      top = rect.bottom + offset;
      if (top + panel.height > viewport.height - 8) top = rect.top - panel.height - offset;
      break;
    case 'bottom-end':
      left = rect.right - panel.width;
      top = rect.bottom + offset;
      if (top + panel.height > viewport.height - 8) top = rect.top - panel.height - offset;
      break;
    case 'top-start':
      left = rect.left;
      top = rect.top - panel.height - offset;
      if (top < 8) top = rect.bottom + offset;
      break;
    case 'top-end':
      left = rect.right - panel.width;
      top = rect.top - panel.height - offset;
      if (top < 8) top = rect.bottom + offset;
      break;
  }
  left = Math.max(8, Math.min(left, viewport.width - panel.width - 8));
  top = Math.max(8, Math.min(top, viewport.height - panel.height - 8));
  return { top, left };
}

/**
 * A floating panel (menu or small dialog) anchored to its trigger, rendered in a portal so that
 * scrolling containers never clip it. Closes on Escape (focus returns to the trigger), outside click and resize.
 */
export function Popover({
  trigger,
  children,
  placement = 'bottom-start',
  label,
  kind = 'menu',
  className,
}: {
  trigger: (props: TriggerProps) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: Placement;
  label: string;
  kind?: 'menu' | 'dialog';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const t = triggerRef.current;
    const p = panelRef.current;
    if (!t || !p) return;
    const r = t.getBoundingClientRect();
    setPos(placePanel(r, { width: p.offsetWidth, height: p.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, placement));
  }, [open, placement]);

  useEffect(() => {
    if (!open || !pos) return;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>(ITEM_SELECTOR);
    first?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'Tab' && kind === 'menu') {
        close(false);
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
      if (!items.length) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    const onResize = () => close(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close, kind]);

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => (open ? close(false) : setOpen(true)),
        'aria-expanded': open,
        'aria-haspopup': kind,
        'aria-controls': open ? id : undefined,
      })}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role={kind}
            aria-label={label}
            className={cx('menu-panel fixed z-[70]', className)}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          >
            {children(() => close(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
  danger,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  hint?: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" tabIndex={-1} className={cx('menu-item', danger && '!text-danger')} onClick={onSelect}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-[12px] text-subtle">{hint}</span>}
    </button>
  );
}

export function MenuLink({ icon, children, to, onSelect }: { icon?: ReactNode; children: ReactNode; to: string; onSelect: () => void }) {
  return (
    <Link to={to} role="menuitem" tabIndex={-1} className="menu-item" onClick={onSelect}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="menu-sep" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-subtle">{children}</div>;
}
