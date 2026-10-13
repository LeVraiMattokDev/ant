/** VAPID key helpers shared by the page and the service worker (no DOM dependency). */

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** True when a subscription was made with this server key (false after a VAPID key rotation). */
export function sameServerKey(subscriptionKey: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!subscriptionKey) return false;
  const a = new Uint8Array(subscriptionKey);
  return a.length === key.length && a.every((v, i) => v === key[i]);
}
