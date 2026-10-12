import { get, post } from './api';
import type { PushPublicKeyDTO } from '@ant/shared';

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
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

export async function enablePush(): Promise<PushSubscription> {
  if (!pushSupported()) {
    throw new Error('Ce navigateur ne gère pas les notifications push. Sur iPhone, installe d’abord Ant sur l’écran d’accueil.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permission de notification refusée par le navigateur.');
  const { publicKey } = await get<PushPublicKeyDTO>('/api/push/public-key');
  if (!publicKey) throw new Error('Le serveur n’a pas de clé VAPID configurée : les push sont désactivés.');
  const reg = await registration();
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  await post('/api/push/subscribe', sub.toJSON());
  return sub;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}
