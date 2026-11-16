<script lang="ts" module>
  export interface Meter {
    key: string;
    label: string;
    value: number | null;
    /** What the value is, in words: "41%" or "6h". */
    text: string;
    n: number;
    /** Below the row's minimum: shown greyed with its n. */
    low?: boolean;
  }
</script>

<script lang="ts">
  // Meters: one share per row (0..1) on a lighter track of the same blue, with its n beside it. A row under its own
  // minimum shows no meter, only how many it has.
  let { rows, label, min = null }: { rows: Meter[]; label: string; min?: number | null } = $props();
</script>

<ul class="meters" aria-label={label}>
  {#each rows as r (r.key)}
    <li class:low={r.low || r.value === null} data-testid="meter-row">
      <span class="name truncate" title={r.label}>{r.label}</span>
      {#if r.value === null}
        <span class="few">{min !== null ? `${r.n} of ${min}` : `n=${r.n}`}</span>
      {:else}
        <span class="track" role="img" aria-label="{r.label}: {r.text} of {r.n}">
          <span class="fill" style:width="{Math.max(0, Math.min(1, r.value)) * 100}%"></span>
        </span>
        <span class="val">{r.text}</span>
        <span class="n">n={r.n}</span>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .meters {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    display: grid;
    grid-template-columns: minmax(5em, 9em) minmax(40px, 1fr) 3.2em 3.8em;
    align-items: center;
    gap: var(--s2);
    font-size: 12px;
  }
  .few {
    grid-column: 2 / -1;
    color: var(--text-muted);
    font-size: 11px;
  }
  .low .name {
    color: var(--text-muted);
  }
  .track {
    height: 8px;
    border-radius: 4px;
    background: var(--viz-track);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--viz-series);
    border-radius: 4px;
  }
  .val,
  .n {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .n {
    color: var(--text-muted);
    font-size: 11px;
  }
</style>
