/**
 * After a deployment, an already open app may ask for a lazy chunk that no longer exists (the new service worker
 * removed it from the precache and the server only has the new hashed files). Vite then fires `vite:preloadError`:
 * reloading fetches the new version. A guard prevents a reload loop; the error boundary explains what happened then.
 */
const RELOAD_KEY = 'ant:chunk-reload';
const RELOAD_GUARD_MS = 10_000;

/** Reloads once for a missing chunk. Returns false when a reload already happened moments ago (or cannot be tracked). */
export function reloadForNewVersion(reload: () => void = () => window.location.reload(), now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (now - last < RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    // Without storage the guard cannot work: never risk a loop.
    return false;
  }
  reload();
  return true;
}

export function installChunkReload(): void {
  // No preventDefault: if the reload is skipped, the import error still reaches the error boundary.
  window.addEventListener('vite:preloadError', () => {
    reloadForNewVersion();
  });
}
