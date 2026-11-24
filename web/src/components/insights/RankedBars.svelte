<script lang="ts" module>
  export interface Ranked {
    key: string;
    label: string;
    n: number;
    href?: string;
    onopen?: () => void;
  }
</script>

<script lang="ts">
  // Ranked horizontal bars, one series in one colour, value at the tip. An "Other" row (greyed) carries the tail.
  let {
    rows,
    other = 0,
    label,
    unit = '',
  }: { rows: Ranked[]; other?: number; label: string; unit?: string } = $props();
  const max = $derived(Math.max(1, ...rows.map((r) => r.n), other));
</script>

<ul class="ranked" aria-label={label}>
  {#each rows as r (r.key)}
    <li data-testid="ranked-row">
      {#if r.href}
        <a
          class="name truncate"
          href={r.href}
          title={r.label}
          onclick={(e) => {
            if (r.onopen) {
              e.preventDefault();
              r.onopen();
            }
          }}
        >
          {r.label}
        </a>
      {:else}
        <span class="name truncate" title={r.label}>{r.label}</span>
      {/if}
      <span class="track"><span class="fill" style:width="{(r.n / max) * 100}%"></span></span>
      <span class="n">{r.n}{unit}</span>
    </li>
  {/each}
  {#if other > 0}
    <li class="other">
      <span class="name">Other</span>
      <span class="track"><span class="fill" style:width="{(other / max) * 100}%"></span></span>
      <span class="n">{other}{unit}</span>
    </li>
  {/if}
</ul>

<style>
  .ranked {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    display: grid;
    grid-template-columns: minmax(6em, 11em) minmax(30px, 1fr) 3em;
    align-items: center;
    gap: var(--s2);
    font-size: 12px;
  }
  a.name {
    color: inherit;
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 2px;
  }
  a.name:hover {
    text-decoration-color: currentColor;
  }
  .track {
    height: 10px;
  }
  .fill {
    display: block;
    height: 100%;
    min-width: 2px;
    background: var(--viz-series);
    border-radius: 0 4px 4px 0;
  }
  .other .fill {
    background: var(--viz-legacy);
  }
  .other .name {
    color: var(--text-muted);
  }
  .n {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
