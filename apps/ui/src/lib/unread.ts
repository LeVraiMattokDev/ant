/** Per-channel "last read" marks kept in localStorage, to show unread dots in the sidebar. */
import { useSyncExternalStore } from 'react';

const KEY = 'ant-last-read';
const listeners = new Set<() => void>();

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const BASELINE = '__baseline';

function init(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  const m = load();
  if (!m[BASELINE]) {
    // First visit: everything that already exists counts as read.
    m[BASELINE] = new Date().toISOString();
    try {
      localStorage.setItem(KEY, JSON.stringify(m));
    } catch {
      /* ignore */
    }
  }
  return m;
}

let marks: Record<string, string> = init();

export function markRead(channelId: string, at: string = new Date().toISOString()): void {
  if (marks[channelId] && marks[channelId] >= at) return;
  marks = { ...marks, [channelId]: at };
  try {
    localStorage.setItem(KEY, JSON.stringify(marks));
  } catch {
    /* ignore quota / private mode */
  }
  for (const l of listeners) l();
}

export function useReadMarks(): Record<string, string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => marks,
    () => marks,
  );
}

export function isUnread(lastMessageAt: string | null, channelId: string, all: Record<string, string>): boolean {
  if (!lastMessageAt) return false;
  const lastRead = all[channelId] ?? all[BASELINE];
  if (!lastRead) return false;
  return lastMessageAt > lastRead;
}
