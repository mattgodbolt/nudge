import { actionKey, isClientUsageKey, type UsageAction, type UsageVia } from '../../../shared/usage';
import { api } from './api';

/**
 * Internal usage counters: which features get used and how. Counts only, flushed to the local server in batches.
 * Keys come from the fixed allow-list in shared/usage.ts and are never built from anything the user typed or read.
 *
 * Nothing here may ever block, throw into or slow the UI: every entry point swallows its own errors, and sending is
 * fire-and-forget. It does nothing at all until `start` is called, and `start` refuses in demo mode and under
 * automated browsers/tests so those never write to a real table.
 */

/** Keymap binding ids that are counted as actions. Anything not listed (menu-internal keys, theme, help...) is not. */
export const BINDING_ACTIONS: Readonly<Record<string, UsageAction>> = {
  'triage.done': 'done',
  'triage.dismiss': 'dismissed',
  'triage.replied': 'replied',
  'triage.inbox': 'inbox',
  'snooze.open': 'snooze',
  'label.open': 'label',
  'mute.open': 'mute',
  'triage.undo': 'undo',
  'reply.open': 'reply',
  'open.comment': 'open_source',
  'open.video': 'open_source',
  'sel.toggle': 'select_toggle',
  'sel.all': 'select_all',
  'sync.now': 'sync',
  'app.refresh': 'sync',
  'thread.focus': 'thread_open',
  'search.focus': 'search_focus',
  'assistant.open': 'assistant_open',
  'nav.next': 'nav',
  'nav.prev': 'nav',
};

/** How a pointer event arrived: a finger or pen is "touch", anything else a button click. */
export function viaOfEvent(e: Event | undefined, fallback: UsageVia = 'btn'): UsageVia {
  const type = (e as { pointerType?: string } | undefined)?.pointerType;
  return type === 'touch' || type === 'pen' ? 'touch' : fallback;
}

const FLUSH_MIN_MS = 60_000;
const HEARTBEAT_MS = 60_000;
/** Hidden for this long and coming back counts as a new session. */
const SESSION_GAP_MS = 30 * 60_000;
/** Input within this long before a heartbeat counts the minute as active. */
const ACTIVE_WINDOW_MS = 60_000;

export interface UsageDeps {
  send: (counts: Record<string, number>) => Promise<unknown>;
  now: () => number;
  /** Wiring to the page; absent in tests that drive the module directly. */
  doc?: Document;
  win?: Window;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  setTick?: typeof setInterval;
  clearTick?: typeof clearInterval;
}

export class Usage {
  #enabled = false;
  #pending = new Map<string, number>();
  #lastFlush = -Infinity;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #hiddenAt: number | null = null;
  #lastInput = -Infinity;
  #stop: (() => void) | undefined;
  #sending = false;

  constructor(private deps: UsageDeps) {}

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Counters waiting to be sent (for tests). */
  get pending(): Record<string, number> {
    return Object.fromEntries(this.#pending);
  }

  /**
   * Begin collecting. A no-op in demo mode and when driven by automation (Playwright sets navigator.webdriver) or
   * running under tests, so none of those can write to a real table.
   */
  start(opts: { demo: boolean; automated?: boolean }): void {
    try {
      if (this.#enabled || opts.demo || opts.automated) return;
      this.#enabled = true;
      this.#attach();
      this.count('session.start');
      this.#device();
    } catch {
      /* analytics never breaks the app */
    }
  }

  /** Stop collecting and drop anything unsent. */
  stop(): void {
    this.#enabled = false;
    this.#stop?.();
    this.#stop = undefined;
    this.#pending.clear();
    this.deps.clearTimer?.(this.#timer);
    this.#timer = undefined;
  }

  count(key: string, n = 1): void {
    try {
      // A key outside the list is dropped here too, so a typo (or a future key built from content) cannot leak out.
      if (!this.#enabled || !isClientUsageKey(key) || !Number.isInteger(n) || n < 1) return;
      this.#pending.set(key, (this.#pending.get(key) ?? 0) + n);
      this.#schedule();
    } catch {
      /* analytics never breaks the app */
    }
  }

  /** An action invoked a given way; combinations the allow-list does not know are ignored. */
  action(action: string, via: UsageVia): void {
    const key = actionKey(action, via);
    if (key) this.count(key);
  }

  /** A keymap binding was run: the single place keyboard, button and palette use is counted. */
  binding(id: string, via: UsageVia): void {
    const action = BINDING_ACTIONS[id];
    if (action) this.action(action, via);
  }

  /** Send what is pending now. Failures keep the counts for the next attempt. */
  flush(): void {
    try {
      if (!this.#enabled || this.#sending || this.#pending.size === 0) return;
      const batch = Object.fromEntries(this.#pending);
      this.#pending.clear();
      this.#lastFlush = this.deps.now();
      this.#sending = true;
      let sent: Promise<unknown>;
      try {
        sent = Promise.resolve(this.deps.send(batch));
      } catch (e) {
        sent = Promise.reject(e);
      }
      sent
        .catch((e: unknown) => {
          // The server saying "bad request" will say it again: drop. Anything else (offline, restarting) retries.
          if ((e as { status?: number } | null)?.status === 400) return;
          for (const [k, n] of Object.entries(batch)) this.#pending.set(k, (this.#pending.get(k) ?? 0) + n);
          this.#schedule();
        })
        .finally(() => (this.#sending = false));
    } catch {
      /* analytics never breaks the app */
    }
  }

  /** At most one flush a minute, however many counts arrive. */
  #schedule(): void {
    if (this.#timer !== undefined || !this.deps.setTimer) return;
    const wait = Math.max(0, this.#lastFlush + FLUSH_MIN_MS - this.deps.now());
    this.#timer = this.deps.setTimer(() => {
      this.#timer = undefined;
      this.flush();
    }, wait);
  }

  #device(): void {
    const { win } = this.deps;
    if (!win) return;
    const standalone = win.matchMedia?.('(display-mode: standalone)').matches ?? false;
    this.count(standalone ? 'app.pwa' : 'app.browser_tab');
    this.count(win.matchMedia?.('(max-width: 899px)').matches ? 'device.phone' : 'device.desktop');
  }

  #attach(): void {
    const { doc, win } = this.deps;
    if (!doc || !win) return;
    const onVisibility = () => {
      if (doc.visibilityState === 'hidden') {
        this.#hiddenAt = this.deps.now();
        this.flush();
      } else {
        const gap = this.#hiddenAt === null ? 0 : this.deps.now() - this.#hiddenAt;
        this.#hiddenAt = null;
        if (gap >= SESSION_GAP_MS) this.count('session.start');
      }
    };
    const onPageHide = () => this.flush();
    const onInput = () => (this.#lastInput = this.deps.now());
    // Active minutes: a heartbeat that counts a minute only if the tab is visible and the owner did something in it.
    const beat = () => {
      if (doc.visibilityState === 'visible' && this.deps.now() - this.#lastInput <= ACTIVE_WINDOW_MS) {
        this.count('session.active_minute');
      }
    };
    const tick = this.deps.setTick?.(beat, HEARTBEAT_MS);
    const inputs = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pagehide', onPageHide);
    for (const t of inputs) win.addEventListener(t, onInput, { passive: true, capture: true });
    this.#stop = () => {
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pagehide', onPageHide);
      for (const t of inputs) win.removeEventListener(t, onInput, { capture: true });
      if (tick !== undefined) this.deps.clearTick?.(tick);
    };
  }
}

const browser = typeof window !== 'undefined' && typeof document !== 'undefined';

/** The app-wide instance. Inert until `usage.start` runs from boot. */
export const usage = new Usage({
  send: (counts) => api.postUsage(counts),
  now: () => Date.now(),
  ...(browser
    ? {
        doc: document,
        win: window,
        setTimer: setTimeout.bind(globalThis) as typeof setTimeout,
        clearTimer: clearTimeout.bind(globalThis) as typeof clearTimeout,
        setTick: setInterval.bind(globalThis) as typeof setInterval,
        clearTick: clearInterval.bind(globalThis) as typeof clearInterval,
      }
    : {}),
});

/** Whether this page is driven by automation or a test run, in which case nothing may be recorded. */
export function isAutomated(): boolean {
  return import.meta.env?.MODE === 'test' || (typeof navigator !== 'undefined' && navigator.webdriver === true);
}
