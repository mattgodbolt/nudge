import { api } from '../api';
import { inbox } from './inbox.svelte';
import { feeds } from './feeds.svelte';
import { labels } from './labels.svelte';
import { settings } from './settings.svelte';
import { sources } from './sources.svelte';
import { sync } from './sync.svelte';
import { theme } from './theme.svelte';

class AppStore {
  ready = $state(false);
  error = $state<string | null>(null);

  async boot(): Promise<void> {
    try {
      const b = await api.bootstrap();
      settings.value = b.settings;
      settings.capabilities = b.capabilities;
      inbox.counts = b.counts;
      labels.set(b.labels);
      sources.set(b.sources);
      feeds.set(b.feeds, b.mutes);
      sync.quota = b.quota;
      sync.status = b.sync;
      theme.adopt(b.settings.theme);
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Could not reach the Nudge server';
    } finally {
      this.ready = true;
    }
  }
}

export const app = new AppStore();
