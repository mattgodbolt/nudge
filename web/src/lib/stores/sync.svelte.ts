import type { QuotaDTO, SyncStatus } from '../../../../shared/types';
import type { SyncRequest } from '../../../../shared/api';
import { api } from '../api';
import { toasts } from './toasts.svelte';

class SyncStore {
  status = $state<SyncStatus>({
    running: false,
    runId: null,
    trigger: null,
    done: 0,
    total: 0,
    currentVideoId: null,
    lastRun: null,
  });
  quota = $state<QuotaDTO | null>(null);
  now = $state(Date.now());
  /** The live event stream is down (the browser is retrying it): the page is not hearing about changes. */
  streamDown = $state(false);

  constructor() {
    if (typeof window !== 'undefined') setInterval(() => (this.now = Date.now()), 30_000);
  }

  get blocked(): boolean {
    const b = this.quota?.blockedUntil;
    return !!b && Date.parse(b) > this.now;
  }

  async run(req: SyncRequest = { scope: 'all' }, label = 'Sync started'): Promise<void> {
    if (this.blocked) {
      toasts.error('YouTube quota exhausted; sync is paused until it resets');
      return;
    }
    try {
      this.status = await api.sync(req);
      toasts.push({ message: label, timeoutMs: 2500 });
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not start sync');
    }
  }
}

export const sync = new SyncStore();
