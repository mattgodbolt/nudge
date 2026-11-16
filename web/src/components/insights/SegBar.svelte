<script lang="ts" module>
  export interface Part {
    key: string;
    label: string;
    n: number;
    /** CSS colour of the block, a --viz-* token. */
    color: string;
    /** Text colour inside the block: light on dark fills, dark on yellow. */
    ink?: 'light' | 'dark';
  }
</script>

<script lang="ts">
  // The tall segmented bar: one whole split into parts (≤6). Each block prints its share inside when it fits; the
  // legend lists every part in block order with its count, so identity never rests on colour alone.
  let { parts, label }: { parts: Part[]; label: string } = $props();

  const total = $derived(parts.reduce((a, p) => a + p.n, 0));
  const share = (n: number) => (total > 0 ? n / total : 0);
  const shown = $derived(parts.filter((p) => p.n > 0));
  let active = $state<string | null>(null);
  const aria = $derived(
    `${label}: ${shown.map((p) => `${p.label} ${Math.round(share(p.n) * 100)}% (${p.n})`).join(', ')}`,
  );
</script>

<div class="seg">
  <div class="bar" role="img" aria-label={aria} data-testid="segbar">
    {#each shown as p (p.key)}
      <span
        class="part"
        class:dark={p.ink === 'dark'}
        style:flex-grow={p.n}
        style:background={p.color}
        onpointerenter={() => (active = p.key)}
        onclick={() => (active = p.key)}
        role="presentation"
        title="{p.label}: {p.n} ({Math.round(share(p.n) * 100)}%)"
      >
        {#if share(p.n) >= 0.12}{Math.round(share(p.n) * 100)}%{/if}
      </span>
    {/each}
  </div>
  <ul class="legend">
    {#each parts as p (p.key)}
      <li class:on={active === p.key}>
        <span class="sw" style:background={p.color}></span>
        <span class="name">{p.label}</span>
        <span class="n">{p.n}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .bar {
    display: flex;
    gap: 2px;
    height: 28px;
  }
  .part {
    flex-basis: 0;
    min-width: 2px;
    border-radius: 4px;
    color: var(--viz-on-dark);
    font-size: 11px;
    font-weight: 600;
    display: flex;
    align-items: center;
    padding-left: 6px;
    white-space: nowrap;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .part.dark {
    color: var(--viz-on-light);
  }
  .legend {
    list-style: none;
    margin: var(--s2) 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10em, 1fr));
    gap: 4px var(--s3);
    font-size: 12px;
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .legend li.on .name {
    text-decoration: underline;
  }
  .sw {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .n {
    margin-left: auto;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
