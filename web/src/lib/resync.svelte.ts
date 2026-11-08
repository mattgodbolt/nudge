import { app } from './stores/app.svelte';
import { inbox } from './stores/inbox.svelte';
import { toasts } from './stores/toasts.svelte';
import { reconnectEvents } from './sse';

/** A tab hidden for less than this is assumed to have kept up with the event stream. */
export const STALE_AFTER_MS = 5_000;

/** Whether coming back to the tab warrants a resync. Pure so the policy is testable. */
export function shouldResyncOnReturn(hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt >= STALE_AFTER_MS;
}

/** The hashed entry script named in an index.html, e.g. /assets/index-AbC123.js (absent in dev). */
export function entryScript(html: string): string | null {
  return /<script[^>]+src="(\/assets\/index-[\w-]+\.js)"/.exec(html)?.[1] ?? null;
}

/** True when the server is now serving a different build than the one this page loaded. */
export function newBuildAvailable(serverHtml: string, loadedSrc: string | null): boolean {
  const served = entryScript(serverHtml);
  return served !== null && loadedSrc !== null && served !== loadedSrc;
}

async function reloadIfOutdated(): Promise<boolean> {
  const loaded = document.querySelector<HTMLScriptElement>('script[type=module][src*="/assets/index-"]');
  if (!loaded) return false;
  try {
    const res = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } });
    if (!res.ok || !newBuildAvailable(await res.text(), loaded.getAttribute('src'))) return false;
    location.reload();
    return true;
  } catch {
    return false;
  }
}

class Resync {
  busy = $state(false);

  /**
   * Bring this tab fully up to date: reload if a newer build was deployed, reopen the event stream, and refetch counts,
   * labels, sources and the top of the list. Only a failure is reported.
   */
  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (await reloadIfOutdated()) return;
      reconnectEvents();
      await Promise.all([app.boot(), inbox.refreshTop()]);
      if (app.error) toasts.error(`Couldn't reach Nudge: ${app.error}`);
    } finally {
      this.busy = false;
    }
  }
}

export const resync = new Resync();

/** Resync when the tab returns to view or the network comes back. Returns a cleanup function. */
export function installAutoResync(): () => void {
  let hiddenAt: number | null = document.hidden ? Date.now() : null;
  const onVisibility = () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const stale = shouldResyncOnReturn(hiddenAt, Date.now());
    hiddenAt = null;
    if (stale) void resync.run();
  };
  const onOnline = () => void resync.run();
  // Restored from the back/forward cache: the whole page is as old as when it was frozen.
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) void resync.run();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pageshow', onPageShow);
  };
}
