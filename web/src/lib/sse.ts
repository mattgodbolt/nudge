import { parsePing } from '../../../shared/build';
import type { ServerEvent } from '../../../shared/types';
import { app } from './stores/app.svelte';
import { feeds } from './stores/feeds.svelte';
import { inbox } from './stores/inbox.svelte';
import { labels } from './stores/labels.svelte';
import { notes } from './stores/notes.svelte';
import { settings } from './stores/settings.svelte';
import { sources } from './stores/sources.svelte';
import { suggestStatus } from './stores/suggestStatus.svelte';
import { sync } from './stores/sync.svelte';
import { theme } from './stores/theme.svelte';
import { update } from './stores/update.svelte';
import { toasts } from './stores/toasts.svelte';

const TYPES: ServerEvent['type'][] = [
  'inbox.changed',
  'suggestions.changed',
  'suggestions.status',
  'notes.changed',
  'sync.progress',
  'sync.done',
  'quota.update',
  'sources.changed',
  'feeds.changed',
  'labels.changed',
  'settings.changed',
  'capabilities.changed',
  'error',
];

export function dispatch(e: ServerEvent) {
  switch (e.type) {
    case 'inbox.changed':
      inbox.applyServerEvent(e);
      break;
    case 'suggestions.changed':
      inbox.applySuggestions(e.suggestions);
      break;
    case 'suggestions.status':
      suggestStatus.set(e.status);
      break;
    case 'notes.changed':
      notes.set(e.notes);
      break;
    case 'sync.progress':
      sync.status = e.status;
      break;
    case 'sync.done':
      sync.status = { ...sync.status, running: false, lastRun: e.summary };
      break;
    case 'quota.update':
      sync.quota = e.quota;
      break;
    case 'sources.changed':
      sources.set(e.sources);
      break;
    case 'feeds.changed':
      feeds.set(e.feeds, e.mutes);
      break;
    case 'labels.changed':
      labels.set(e.labels);
      inbox.pruneLabels(new Set(e.labels.map((l) => l.id)));
      break;
    case 'settings.changed':
      settings.value = e.settings;
      theme.adopt(e.settings.theme);
      break;
    case 'capabilities.changed':
      settings.capabilities = e.capabilities;
      break;
    case 'error':
      toasts.error(e.message);
      break;
  }
}

let current: { reconnect(): void } | null = null;

/** The server sends a ping every 20s; this long without hearing anything means the stream is dead. */
export const STREAM_SILENT_MS = 70_000;

/** Pure so the policy is testable: has the stream been silent for too long? */
export function streamIsSilent(lastHeardAt: number, now: number): boolean {
  return now - lastHeardAt >= STREAM_SILENT_MS;
}

/**
 * Drop and reopen the event stream. A phone that has had the tab frozen in the background can hold a connection that
 * looks open but is dead, so no error ever fires; reopening is the only way to know.
 */
export function reconnectEvents(): void {
  current?.reconnect();
}

/** One EventSource for the app's lifetime; on reconnect we re-bootstrap to resync. */
export function connectEvents(): () => void {
  let es: EventSource;
  let wasDown = false;
  let lastHeardAt = Date.now();
  const open = () => {
    es = new EventSource('/api/events');
    lastHeardAt = Date.now();
    es.addEventListener('ping', (ev) => {
      lastHeardAt = Date.now();
      // Each ping names the web build the server is serving: a page left open across a deploy learns of it here.
      update.noteServerBuild(parsePing((ev as MessageEvent).data).build);
    });
    for (const type of TYPES) {
      es.addEventListener(type, (ev) => {
        lastHeardAt = Date.now();
        try {
          dispatch(JSON.parse((ev as MessageEvent).data) as ServerEvent);
        } catch {
          /* ignore malformed event */
        }
      });
    }
    es.onopen = () => {
      if (wasDown) {
        wasDown = false;
        void app.boot();
        void inbox.refreshTop();
      }
    };
    es.onerror = () => {
      wasDown = true;
    };
  };
  open();
  // A dead stream on a tab that is still in view never errors and never triggers the return-to-tab resync.
  const watchdog = setInterval(() => {
    if (document.hidden || !streamIsSilent(lastHeardAt, Date.now())) return;
    me.reconnect();
    void app.boot();
    void inbox.refreshTop();
  }, 15_000);
  const me = {
    reconnect() {
      es.close();
      wasDown = false; // the caller resyncs explicitly
      open();
    },
  };
  current = me;
  return () => {
    clearInterval(watchdog);
    es.close();
    if (current === me) current = null;
  };
}
