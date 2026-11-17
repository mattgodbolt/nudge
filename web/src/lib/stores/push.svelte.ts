import type { PushPrefs } from '../../../../shared/types';
import { api } from '../api';
import { deviceLabel, pushSupported, urlBase64ToUint8Array } from '../push';
import { toasts } from './toasts.svelte';

export type PushStatus =
  /** Looking at what this browser has. */
  | 'checking'
  /** No service worker / Push API / secure context. */
  | 'unsupported'
  /** The user (or the browser) refused notifications for this site. */
  | 'blocked'
  | 'off'
  | 'on';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DEFAULT_PREFS: PushPrefs = { newComments: true, snoozeWake: true };

/** Notification state for *this device*: its browser subscription plus the preferences the server keeps for it. */
class PushStore {
  status = $state<PushStatus>('checking');
  prefs = $state<PushPrefs>({ ...DEFAULT_PREFS });
  busy = $state(false);
  /** Set when the browser offered to install Nudge as an app and the user has not yet. */
  canInstall = $state(false);
  installed = $state(false);
  #install: InstallPromptEvent | null = null;
  #started = false;

  /** Idempotent. Safe to call before the service worker is ready. */
  async init(): Promise<void> {
    if (this.#started || typeof window === 'undefined') return;
    this.#started = true;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.#install = e as InstallPromptEvent;
      this.canInstall = true;
    });
    window.addEventListener('appinstalled', () => {
      this.#install = null;
      this.canInstall = false;
      this.installed = true;
    });
    this.installed = window.matchMedia?.('(display-mode: standalone)').matches ?? false;

    if (!pushSupported(window, navigator)) {
      this.status = 'unsupported';
      return;
    }
    await this.refresh();
  }

  async #subscription(): Promise<PushSubscription | null> {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  /** Reconcile the browser's subscription with the server's record of it. */
  async refresh(): Promise<void> {
    try {
      if (Notification.permission === 'denied') {
        this.status = 'blocked';
        return;
      }
      const sub = await this.#subscription();
      if (!sub) {
        this.status = 'off';
        return;
      }
      let state = await api.pushState(sub.endpoint);
      if (!state.subscribed) {
        // The server lost this device (database restored from an older backup): quietly register it again.
        state = await api.pushSubscribe(sub.toJSON() as never, this.prefs, deviceLabel(navigator.userAgent));
      }
      this.prefs = state.prefs;
      this.status = 'on';
    } catch {
      // Server unreachable or push unavailable there: leave the controls usable and try again when asked.
      this.status = (await this.#subscription().catch(() => null)) ? 'on' : 'off';
    }
  }

  async enable(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        this.status = permission === 'denied' ? 'blocked' : 'off';
        return;
      }
      const { publicKey } = await api.pushConfig();
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      const key = urlBase64ToUint8Array(publicKey);
      if (sub && !sameKey(sub.options.applicationServerKey, key)) {
        // Subscribed under an older server key (database was reset): that subscription can never be delivered to.
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const state = await api.pushSubscribe(sub.toJSON() as never, this.prefs, deviceLabel(navigator.userAgent));
      this.prefs = state.prefs;
      this.status = 'on';
    } catch (e) {
      toasts.error(
        e instanceof Error ? `Could not turn on notifications: ${e.message}` : 'Could not turn on notifications',
      );
      await this.refresh();
    } finally {
      this.busy = false;
    }
  }

  async disable(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const sub = await this.#subscription();
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint).catch(() => {});
        await sub.unsubscribe();
      }
      this.status = 'off';
    } catch (e) {
      toasts.fail(e, 'Could not turn off notifications');
    } finally {
      this.busy = false;
    }
  }

  async setPref(key: keyof PushPrefs, value: boolean): Promise<void> {
    const before = this.prefs;
    this.prefs = { ...before, [key]: value };
    try {
      const sub = await this.#subscription();
      if (!sub) throw new Error('This device is not subscribed');
      const state = await api.pushSubscribe(sub.toJSON() as never, { [key]: value });
      this.prefs = state.prefs;
    } catch (e) {
      this.prefs = before;
      toasts.fail(e, 'Could not save');
    }
  }

  async sendTest(): Promise<void> {
    try {
      const sub = await this.#subscription();
      if (!sub) throw new Error('This device is not subscribed');
      const { result } = await api.pushTest(sub.endpoint);
      if (result === 'ok') toasts.success('Test notification sent');
      else if (result === 'gone') {
        toasts.error('The push service no longer knows this device. Turn notifications off and on again.');
        await this.refresh();
      } else toasts.error('The push service did not accept the test. Check the server log.');
    } catch (e) {
      toasts.fail(e, 'Could not send a test');
    }
  }

  async install(): Promise<void> {
    const ev = this.#install;
    if (!ev) return;
    await ev.prompt();
    await ev.userChoice;
    this.#install = null;
    this.canInstall = false;
  }
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

export const push = new PushStore();
