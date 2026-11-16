import { api } from '../api';
import { inbox } from './inbox.svelte';
import { feeds } from './feeds.svelte';
import { settings } from './settings.svelte';
import { sources } from './sources.svelte';
import { suggestStatus } from './suggestStatus.svelte';
import { sync } from './sync.svelte';
import { theme } from './theme.svelte';
import { router } from '../router.svelte';
import { isAutomated, usage } from '../usage';
import { decisions } from '../decisions';

class AppStore {
  ready = $state(false);
  error = $state<string | null>(null);
  /** boot() runs again on every resync, reconnect and watchdog; the view it opened on is one view, counted once. */
  #viewCounted = false;

  async boot(): Promise<void> {
    try {
      const b = await api.bootstrap();
      settings.value = b.settings;
      settings.capabilities = b.capabilities;
      inbox.counts = b.counts;
      sources.set(b.sources);
      feeds.set(b.feeds, b.mutes);
      suggestStatus.set(b.suggestStatus);
      sync.quota = b.quota;
      sync.status = b.sync;
      theme.adopt(b.settings.theme);
      usage.start({ demo: b.settings.demo, automated: isAutomated() });
      decisions.start({ demo: b.settings.demo, automated: isAutomated() });
      if (!this.#viewCounted) {
        this.#viewCounted = true;
        usage.count(`view.${router.route}`);
      }
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Could not reach the Nudge server';
    } finally {
      this.ready = true;
    }
  }
}

export const app = new AppStore();
