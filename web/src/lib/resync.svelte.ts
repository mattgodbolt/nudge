import { app } from './stores/app.svelte';
import { toasts } from './stores/toasts.svelte';
import { reconnectEvents, refetchState } from './sse';

/** A tab hidden for less than this is assumed to have kept up with the event stream. */
export const STALE_AFTER_MS = 5_000;

/** Whether coming back to the tab warrants a resync. Pure so the policy is testable. */
export function shouldResyncOnReturn(hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt >= STALE_AFTER_MS;
}

class Resync {
  busy = $state(false);

  /**
   * Bring this tab's data up to date: reopen the event stream, and refetch counts, sources, the top of the list and
   * the open thread. Only a failure is reported. It never reloads the page, even after a deploy: that would throw away
   * anything half-typed. The reopened stream's first ping names the server's build, which raises the "New version available"
   * prompt instead (see update.svelte.ts).
   */
  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      reconnectEvents();
      await refetchState();
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
