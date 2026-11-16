<script lang="ts">
  import { sync } from '../lib/stores/sync.svelte';
  import { ago } from '../lib/format';
  import { tip } from '../lib/tip.svelte';
  import Icon from './Icon.svelte';

  const label = $derived(
    sync.streamDown
      ? 'Live updates lost · Reconnecting…'
      : sync.status.running
        ? sync.status.total > 0
          ? `Syncing ${sync.status.done}/${sync.status.total}`
          : 'Syncing…'
        : sync.blocked
          ? 'Quota exhausted'
          : sync.status.lastRun
            ? `Synced ${ago(sync.status.lastRun.finishedAt ?? sync.status.lastRun.startedAt, sync.now)}`
            : 'Not synced yet',
  );
</script>

<button
  class="sync"
  onclick={(e) => {
    void sync.run({ scope: 'all' });
    if (e.detail > 0) e.currentTarget.blur();
  }}
  data-testid="sync-indicator"
  class:down={sync.streamDown}
  {@attach tip({ id: 'sync.now', label: 'Sync now' })}
>
  <span class="spin" class:on={sync.status.running}><Icon name="refresh" size={14} /></span>
  <span class="truncate">{label}</span>
</button>

<style>
  .sync {
    display: flex;
    align-items: center;
    gap: var(--s2);
    width: 100%;
    padding: 5px var(--s2);
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: var(--fs-meta);
    border-radius: var(--radius);
    cursor: pointer;
    text-align: left;
  }
  .sync:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .spin.on {
    animation: spin 1s linear infinite;
    color: var(--accent);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .sync.down {
    color: var(--danger);
  }
</style>
