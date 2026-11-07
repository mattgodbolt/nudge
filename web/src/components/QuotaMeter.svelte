<script lang="ts">
  import { sync } from '../lib/stores/sync.svelte';
  import { formatNumber } from '../lib/format';

  const q = $derived(sync.quota);
  const pct = $derived(q && q.budget > 0 ? Math.min(100, (q.used / q.budget) * 100) : 0);
  const reservePct = $derived(q && q.budget > 0 ? ((q.budget - q.reserve) / q.budget) * 100 : 100);
</script>

{#if q}
  <div class="quota" title="YouTube API units used today (Pacific time)" data-testid="quota-meter">
    <div class="row meta muted">
      <span>Quota</span>
      <span class="mono">{formatNumber(q.used)} / {formatNumber(q.budget)}</span>
    </div>
    <div class="bar">
      <div class="fill" class:warn={pct >= reservePct} class:full={pct >= 100} style:width="{pct}%"></div>
      <div class="mark" style:left="{reservePct}%"></div>
    </div>
  </div>
{/if}

<style>
  .quota {
    padding: 0 var(--s2);
  }
  .row {
    display: flex;
    justify-content: space-between;
    font-size: var(--fs-label);
    margin-bottom: 4px;
  }
  .bar {
    position: relative;
    height: 4px;
    background: var(--bg-hover);
    border-radius: 2px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--secondary);
    transition: width 300ms var(--ease);
  }
  .fill.warn {
    background: var(--warn);
  }
  .fill.full {
    background: var(--danger);
  }
  .mark {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border-strong);
  }
</style>
