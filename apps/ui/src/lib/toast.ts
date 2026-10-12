/** Minimal toast store usable from React and from non-React code (WebSocket, API errors). */
import { useSyncExternalStore } from 'react';
import { errorMessage } from './api';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  level: ToastLevel;
  title: string;
  body?: string;
  url?: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l();
}

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  toasts = toasts.filter((x) => x.id !== id);
  emit();
}

export function pushToast(t: Omit<Toast, 'id'>, durationMs?: number): number {
  const id = nextId++;
  toasts = [...toasts.slice(-4), { ...t, id }];
  emit();
  const ms = durationMs ?? (t.level === 'error' ? 8000 : 5000);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), ms),
  );
  return id;
}

export const toast = {
  info: (title: string, body?: string) => pushToast({ level: 'info', title, body }),
  success: (title: string, body?: string) => pushToast({ level: 'success', title, body }),
  warning: (title: string, body?: string) => pushToast({ level: 'warning', title, body }),
  error: (title: string, body?: string) => pushToast({ level: 'error', title, body }),
  fromError: (err: unknown, title = 'Échec') => pushToast({ level: 'error', title, body: errorMessage(err) }),
};

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
}
