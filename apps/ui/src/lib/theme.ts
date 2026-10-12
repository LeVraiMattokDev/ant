import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'ant-theme';
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', theme === 'light' ? '#ffffff' : '#1c1c1c');
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage disabled: the choice lasts for this page only */
  }
  for (const l of listeners) l();
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getTheme,
    () => 'dark' as Theme,
  );
  return [theme, setTheme];
}
