import { useEffect } from 'react';
import { api } from './api.ts';
import type { AppConfig } from './config.ts';

/** Web push needs a service worker and the Push API (on iPhone: the app added to the Home Screen). */
export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Asks permission, subscribes this device and registers it with the API. */
export async function enablePush(cfg: AppConfig, token: string): Promise<void> {
  if (!pushSupported()) throw new Error('This browser can’t receive push notifications');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error('Notifications are blocked for this site in your browser settings');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>(cfg, token, 'GET', '/push/key');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  await api(cfg, token, 'POST', '/push/subscriptions', sub.toJSON());
}

/** Removes this device's subscription. */
export async function disablePush(cfg: AppConfig, token: string): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api(cfg, token, 'POST', '/push/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

/**
 * Opens the screen a push notification points at: from `?go=` when the app
 * was launched by the notification, or a message from the service worker
 * when the app was already open.
 */
export function useDeepLink(open: (link: string) => void): void {
  useEffect(() => {
    const url = new URL(window.location.href);
    const go = url.searchParams.get('go');
    if (go) {
      open(go);
      url.searchParams.delete('go');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'bmg-go' && typeof e.data.link === 'string') open(e.data.link);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
    // Runs once: `open` changes identity on every render.
  }, []);
}
