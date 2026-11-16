import * as webpush from 'web-push';
import type { PushPayload, PushSender, PushSendResult, Repo } from '../contracts.js';

/**
 * Hostnames of the push services browsers hand out endpoints for. The server POSTs to whatever endpoint a client
 * registers, so anything outside this list is refused rather than letting a request make the server call arbitrary URLs.
 */
const PUSH_HOSTS: RegExp[] = [
  /^fcm\.googleapis\.com$/, // Chrome / Android
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/, // Edge
  /^web\.push\.apple\.com$/, // Safari
  /\.push\.apple\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.username && !u.password && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** Load the VAPID key pair from the database, generating and storing one on first use. */
export function ensureVapidKeys(repo: Pick<Repo, 'getVapidKeys' | 'setVapidKeys'>): {
  publicKey: string;
  privateKey: string;
} {
  const existing = repo.getVapidKeys();
  if (existing) return existing;
  const keys = webpush.generateVAPIDKeys();
  repo.setVapidKeys(keys);
  return keys;
}

export interface WebPushSenderOptions {
  keys: { publicKey: string; privateKey: string };
  /** mailto: or https: URL identifying the sender to the push service. */
  subject: string;
  /** Seconds a push service may hold an undelivered message (a phone that is off). */
  ttlSeconds?: number;
}

/** The real sender: RFC 8030/8291 encryption plus VAPID auth, via the web-push library. */
export function createWebPushSender(opts: WebPushSenderOptions): PushSender {
  const vapidDetails = { subject: opts.subject, publicKey: opts.keys.publicKey, privateKey: opts.keys.privateKey };
  return {
    async send(sub, payload: PushPayload): Promise<PushSendResult> {
      if (!isAllowedPushEndpoint(sub.endpoint)) return 'gone';
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { vapidDetails, TTL: opts.ttlSeconds ?? 6 * 3600, urgency: 'normal', timeout: 15_000 },
        );
        return 'ok';
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // 404/410: the subscription is permanently dead (app uninstalled, permission revoked).
        if (status === 404 || status === 410) return 'gone';
        console.warn('Push send failed:', status ?? '', e instanceof Error ? e.message : e);
        return 'error';
      }
    },
  };
}
