import { parseLocation } from './router.svelte';

/** Web Push needs a service worker, the Push API and notifications, in a secure context (HTTPS or localhost). */
export function pushSupported(
  w: Pick<Window, 'isSecureContext'> & { PushManager?: unknown; Notification?: unknown },
  nav: { serviceWorker?: unknown },
): boolean {
  return !!w.isSecureContext && !!nav.serviceWorker && !!w.PushManager && !!w.Notification;
}

/** VAPID public keys travel as base64url; pushManager.subscribe wants the raw bytes. */
export function urlBase64ToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A short human label for this device, kept with the subscription so it can be told apart later. */
export function deviceLabel(ua: string): string {
  const android = /Android[^;)]*;\s*([^;)]+?)(?:\sBuild|[;)])/.exec(ua)?.[1]?.trim();
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : 'Browser';
  if (/Android/.test(ua)) return `${browser} on ${android && android !== 'K' ? android : 'Android'}`;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** A path from a notification tap (the service worker posts it) -> the router. Anything not a local path is ignored. */
export function openFromNotification(
  url: unknown,
  navigate: (route: ReturnType<typeof parseLocation>) => void,
): boolean {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return false;
  const u = new URL(url, 'http://local');
  navigate(parseLocation(u.pathname, u.search));
  return true;
}
