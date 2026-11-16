<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { InsightCard } from '../../../../shared/insights';
  import { lowData } from '../../lib/insights';

  // One Insights card: a title, a caption that describes (never explains), the chart, and a table view of the same
  // numbers. Under its minimum it keeps the title and says how far off it is, with no chart.
  let {
    id,
    title,
    card,
    caption = null,
    note = null,
    wide = false,
    chart,
    table,
  }: {
    id: string;
    title: string;
    card: InsightCard<unknown>;
    caption?: string | null;
    note?: string | null;
    wide?: boolean;
    chart: Snippet;
    table?: Snippet;
  } = $props();

  let showTable = $state(false);
</script>

<article class="panel card" class:wide data-testid="insight-{id}" aria-labelledby="insight-{id}-title">
  <h3 id="insight-{id}-title">{title}</h3>
  {#if card.data === null}
    <p class="low" data-testid="insight-low">{lowData(card)}</p>
  {:else}
    {#if caption}<p class="caption" data-testid="insight-caption">{caption}</p>{/if}
    <div class="body">
      {#if showTable && table}{@render table()}{:else}{@render chart()}{/if}
    </div>
    {#if note}<p class="note">{note}</p>{/if}
    {#if table}
      <button class="toggle" type="button" aria-pressed={showTable} onclick={() => (showTable = !showTable)}>
        {showTable ? 'Show chart' : 'Show as table'}
      </button>
    {/if}
  {/if}
</article>

<style>
  .card {
    padding: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    min-width: 0;
  }
  .wide {
    grid-column: 1 / -1;
  }
  h3 {
    font-size: 13px;
    font-weight: 600;
  }
  .caption {
    font-size: 13px;
    color: var(--text);
    line-height: 1.4;
  }
  .low,
  .note {
    font-size: 12px;
    color: var(--text-muted);
  }
  .body {
    min-width: 0;
  }
  .toggle {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 2px 0;
    font: inherit;
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .toggle:hover {
    color: var(--text);
  }
  .toggle:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
    border-radius: 2px;
  }
  /* Shared table look for every card's table view. */
  .card :global(table.itable) {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .card :global(table.itable th) {
    text-align: left;
    font-weight: 500;
    color: var(--text-muted);
    padding: 2px 4px;
  }
  .card :global(table.itable td) {
    padding: 2px 4px;
    border-top: 1px solid var(--border);
  }
  .card :global(.num) {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .card :global(.tablewrap) {
    overflow-x: auto;
    max-height: 320px;
    overflow-y: auto;
  }
</style>
