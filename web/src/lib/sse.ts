import type { ServerEvent } from '../../../shared/types';
import { app } from './stores/app.svelte';
import { inbox } from './stores/inbox.svelte';
import { settings } from './stores/settings.svelte';
import { sources } from './stores/sources.svelte';
import { sync } from './stores/sync.svelte';
import { theme } from './stores/theme.svelte';
import { toasts } from './stores/toasts.svelte';

const TYPES: ServerEvent['type'][] = [
  'inbox.changed',
  'sync.progress',
  'sync.done',
  'quota.update',
  'sources.changed',
  'settings.changed',
  'error',
];

export function dispatch(e: ServerEvent) {
  switch (e.type) {
    case 'inbox.changed':
      inbox.applyServerEvent(e);
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
    case 'settings.changed':
      settings.value = e.settings;
      theme.adopt(e.settings.theme);
      break;
    case 'error':
      toasts.error(e.message);
      break;
  }
}

/** One EventSource for the app's lifetime; on reconnect we re-bootstrap to resync. */
export function connectEvents(): () => void {
  const es = new EventSource('/api/events');
  let wasDown = false;
  for (const type of TYPES) {
    es.addEventListener(type, (ev) => {
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
  return () => es.close();
}
