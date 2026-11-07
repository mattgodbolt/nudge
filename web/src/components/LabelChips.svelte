<script lang="ts">
  import { labels, labelColorVar } from '../lib/stores/labels.svelte';

  let { ids, max = 3 }: { ids: readonly number[]; max?: number } = $props();

  const all = $derived(labels.resolve(ids));
  const shown = $derived(all.slice(0, max));
  const extra = $derived(all.length - shown.length);
</script>

{#if all.length > 0}
  <span class="chips" data-testid="label-chips">
    {#each shown as l (l.id)}
      <span class="lchip" style:--lc={labelColorVar(l.color)} title={l.name}>
        <i class="dot"></i><span class="name truncate">{l.name}</span>
      </span>
    {/each}
    {#if extra > 0}
      <span
        class="lchip more"
        title={all
          .slice(max)
          .map((l) => l.name)
          .join(', ')}>+{extra}</span
      >
    {/if}
  </span>
{/if}

<style>
  .chips {
    display: inline-flex;
    gap: 4px;
    min-width: 0;
    flex: none;
    max-width: 100%;
  }
  .lchip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 16px;
    padding: 0 6px 0 5px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 1;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--lc, var(--text-faint)) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--lc, var(--text-faint)) 30%, transparent);
    min-width: 0;
  }
  .lchip.more {
    --lc: var(--text-faint);
    padding: 0 5px;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--lc);
    flex: none;
  }
  .name {
    max-width: 84px;
  }
</style>
