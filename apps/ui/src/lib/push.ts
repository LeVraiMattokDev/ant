import { get, post } from './api';
import type { PushPublicKeyDTO } from '@ant/shared';
import { sameServerKey, urlBase64ToUint8Array } from './vapid';

export { urlBase64ToUint8Array } from './vapid';

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  if (!import.meta.env.PROD) {
    throw new Error('Les notifications nécessitent le service worker, actif uniquement dans la version compilée de l’interface.');
  }
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/**
 * Endpoint confirmed by the server during this page's lifetime. Every registration writes an audit entry, so
 * opening the settings again does not register the same subscription twice.
 */
let registeredEndpoint: string | null = null;

async function serverKey(): Promise<Uint8Array<ArrayBuffer>> {
  const { publicKey } = await get<PushPublicKeyDTO>('/api/push/public-key');
  if (!publicKey) throw new Error('Le serveur n’a pas de clé VAPID configurée : les push sont désactivés.');
  return urlBase64ToUint8Array(publicKey);
}

async function register(sub: PushSubscription): Promise<void> {
  await post('/api/push/subscribe', sub.toJSON());
  registeredEndpoint = sub.endpoint;
}

export async function enablePush(): Promise<PushSubscription> {
  if (!pushSupported()) {
    throw new Error('Ce navigateur ne gère pas les notifications push. Sur iPhone, installe d’abord Ant sur l’écran d’accueil.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permission de notification refusée par le navigateur.');
  const key = await serverKey();
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a previous VAPID key never receives anything again: replace it.
  if (sub && !sameServerKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  const created = !sub;
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  try {
    await register(sub);
  } catch (err) {
    // The server does not know it: a browser subscription left behind would make this device look enabled.
    if (created) await sub.unsubscribe().catch(() => false);
    throw err;
  }
  return sub;
}

/**
 * Whether this device really receives pushes: the browser has a subscription made with the server's current key,
 * and the server has it (registered again, idempotently, in case its copy was removed).
 */
export async function syncPush(): Promise<boolean> {
  const sub = await currentSubscription();
  if (!sub) return false;
  const { publicKey } = await get<PushPublicKeyDTO>('/api/push/public-key');
  if (!publicKey || !sameServerKey(sub.options.applicationServerKey, urlBase64ToUint8Array(publicKey))) return false;
  if (registeredEndpoint !== sub.endpoint) await register(sub);
  return true;
}

/**
 * Stops pushes to this device. The browser subscription is always removed, even when the server cannot be told
 * (offline, session already expired): the push service then answers "gone" and the server drops its copy at the
 * next send.
 */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  registeredEndpoint = null;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}
