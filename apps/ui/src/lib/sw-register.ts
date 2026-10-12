/** Registers the service worker built by vite-plugin-pwa (injectManifest). Production builds only. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Without a service worker the app still works; only offline shell and push are lost.
    });
  });
}
