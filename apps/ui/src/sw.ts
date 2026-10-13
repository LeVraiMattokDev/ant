/// <reference lib="webworker" />
/**
 * Ant service worker (vite-plugin-pwa, injectManifest).
 * - precaches the app shell and serves index.html for SPA navigations (never for /api/);
 * - shows Web Push notifications and opens the right screen on click.
 * Approvals are never decided from here: the "Approuver" action only opens the card.
 */
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { urlBase64ToUint8Array } from './lib/vapid';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null } | string> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  }),
);

interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  approvalId?: string;
}

function parsePayload(event: PushEvent): PushPayload {
  try {
    const data = event.data?.json() as Partial<PushPayload> | undefined;
    if (data && typeof data.title === 'string') {
      return {
        title: data.title,
        body: typeof data.body === 'string' ? data.body : '',
        url: typeof data.url === 'string' ? data.url : undefined,
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        approvalId: typeof data.approvalId === 'string' ? data.approvalId : undefined,
      };
    }
  } catch {
    /* not JSON */
  }
  return { title: 'Ant', body: event.data?.text() ?? '' };
}

self.addEventListener('push', (event: PushEvent) => {
  const p = parsePayload(event);
  const options: NotificationOptions & { actions?: { action: string; title: string }[] } = {
    body: p.body,
    tag: p.tag,
    icon: '/pwa-192.png',
    badge: '/favicon-32.png',
    data: { url: p.url ?? (p.approvalId ? `/approvals?id=${encodeURIComponent(p.approvalId)}` : '/'), approvalId: p.approvalId },
    actions: p.approvalId
      ? [
          { action: 'approve', title: 'Approuver' },
          { action: 'open', title: 'Ouvrir' },
        ]
      : [],
  };
  event.waitUntil(self.registration.showNotification(p.title, options));
});

/** Only same-origin paths are opened. */
function safePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '/';
  try {
    const u = new URL(raw, self.location.origin);
    return u.origin === self.location.origin ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { url?: string; approvalId?: string };
  // "approve" opens the approval card: the decision is always taken in the app, with the full context.
  const target =
    event.action === 'approve' && data.approvalId ? `/approvals?id=${encodeURIComponent(data.approvalId)}` : safePath(data.url);

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        // The app listens for this message and navigates without reloading (see App.tsx).
        client.postMessage({ type: 'ant:navigate', url: target });
        await client.focus();
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

/** `pushsubscriptionchange` (fired by Firefox when the push service renews a subscription); absent from the TS lib. */
interface SubscriptionChangeEvent extends ExtendableEvent {
  readonly oldSubscription?: PushSubscription | null;
  readonly newSubscription?: PushSubscription | null;
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    // Same CSRF header as the app's own requests (lib/api.ts).
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ant' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Registers the renewed subscription with the server, otherwise pushes would silently stop reaching this device. */
async function renewSubscription(event: SubscriptionChangeEvent): Promise<void> {
  let sub = event.newSubscription ?? null;
  if (!sub) {
    let key: ArrayBuffer | Uint8Array<ArrayBuffer> | null = event.oldSubscription?.options.applicationServerKey ?? null;
    if (!key) {
      const res = await fetch('/api/push/public-key', { credentials: 'include' });
      if (!res.ok) return;
      const { publicKey } = (await res.json()) as { publicKey?: string | null };
      if (!publicKey) return;
      key = urlBase64ToUint8Array(publicKey);
    }
    sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  await postJson('/api/push/subscribe', sub.toJSON());
  const old = event.oldSubscription;
  if (old && old.endpoint !== sub.endpoint) await postJson('/api/push/unsubscribe', { endpoint: old.endpoint }).catch(() => undefined);
}

self.addEventListener('pushsubscriptionchange' as keyof ServiceWorkerGlobalScopeEventMap, (event) => {
  const e = event as SubscriptionChangeEvent;
  e.waitUntil(renewSubscription(e).catch(() => undefined));
});
