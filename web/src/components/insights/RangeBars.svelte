<script lang="ts" module>
  export interface RangeRow {
    key: string;
    label: string;
    n: number;
    p25: number | null;
    median: number | null;
    p75: number | null;
  }
</script>

<script lang="ts">
  import { shortDuration } from '../../lib/insights';

  // Box-free spread: a thin bar from the 25th to the 75th percentile and a dot at the median, per row, on one shared
  // log scale of time (ages run from minutes to months). Rows under their minimum show only their n.
  let { rows, label, min }: { rows: RangeRow[]; label: string; min: number } = $props();

  const HOUR = 3_600_000;
  const TICKS = [
    { ms: HOUR, label: '1h' },
    { ms: 24 * HOUR, label: '1d' },
    { ms: 7 * 24 * HOUR, label: '1w' },
    { ms: 30 * 24 * HOUR, label: '1mo' },
    { ms: 365 * 24 * HOUR, label: '1y' },
  ];
  const lo = $derived(Math.min(HOUR / 4, ...rows.flatMap((r) => (r.p25 !== null ? [Math.max(60_000, r.p25)] : []))));
  const hi = $derived(Math.max(24 * HOUR, ...rows.flatMap((r) => (r.p75 !== null ? [r.p75] : []))));
  const x = (v: number) => {
    const a = Math.log(lo);
    const b = Math.log(hi);
    return Math.max(0, Math.min(100, ((Math.log(Math.max(lo, v)) - a) / (b - a)) * 100));
  };
  const ticks = $derived(TICKS.filter((t) => t.ms >= lo && t.ms <= hi));
</script>

<div class="rb" aria-label={label} role="group">
  {#each rows as r (r.key)}
    <div class="row" data-testid="range-row">
      <span class="name">{r.label}</span>
      {#if r.median === null || r.p25 === null || r.p75 === null}
        <span class="few">{r.n} of {min}</span>
      {:else}
        <span
          class="plot"
          role="img"
          aria-label="{r.label}: median {shortDuration(r.median)}, middle half {shortDuration(r.p25)} to {shortDuration(
            r.p75,
          )}, n={r.n}"
        >
          {#each ticks as t (t.label)}<span class="grid" style:left="{x(t.ms)}%"></span>{/each}
          <span class="span" style:left="{x(r.p25)}%" style:width="{Math.max(1, x(r.p75) - x(r.p25))}%"></span>
          <span class="dot" style:left="{x(r.median)}%"></span>
        </span>
        <span class="val">{shortDuration(r.median)}</span>
      {/if}
    </div>
  {/each}
  <div class="row axis" aria-hidden="true">
    <span></span>
    <span class="ticks">
      {#each ticks as t (t.label)}<span style:left="{x(t.ms)}%">{t.label}</span>{/each}
    </span>
    <span></span>
  </div>
</div>

<style>
  .rb {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(5em, 8em) minmax(60px, 1fr) 3em;
    align-items: center;
    gap: var(--s2);
    font-size: 12px;
  }
  .few {
    grid-column: 2 / -1;
    color: var(--text-muted);
    font-size: 11px;
  }
  .plot {
    position: relative;
    height: 14px;
  }
  .grid {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--viz-grid);
  }
  .span {
    position: absolute;
    top: 5px;
    height: 4px;
    border-radius: 2px;
    background: var(--viz-seq-2);
  }
  .dot {
    position: absolute;
    top: 2px;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    border-radius: 50%;
    background: var(--viz-series);
    box-shadow: 0 0 0 2px var(--bg-elev);
  }
  .val {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .ticks {
    position: relative;
    height: 1.2em;
    font-size: 11px;
    color: var(--text-muted);
  }
  .ticks span {
    position: absolute;
    transform: translateX(-50%);
  }
</style>
