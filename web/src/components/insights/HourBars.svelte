<script lang="ts">
  import { hourLabel, hourTick } from '../../lib/insights';

  // 24 columns, one series, its own axis: R3 stacks two of these (arrivals, then actions) rather than sharing a
  // dual-axis plot. Tap or hover a column for its value in the line underneath.
  let { values, unit, label }: { values: readonly number[]; unit: string; label: string } = $props();

  const max = $derived(Math.max(0, ...values));
  let active = $state<number | null>(null);
  const total = $derived(values.reduce((a, b) => a + b, 0));
</script>

<div class="hb">
  <div class="head">
    <span class="name">{label}</span>
    <span class="max">max {max}</span>
  </div>
  <div
    class="cols"
    role="img"
    aria-label="{label} by hour of day: {total} in all, most at {hourLabel(values.indexOf(max))}"
  >
    {#each values as v, h (h)}
      <span
        class="col"
        class:on={active === h}
        onpointerenter={() => (active = h)}
        onclick={() => (active = h)}
        role="presentation"
      >
        <span class="bar" style:height="{max > 0 ? (v / max) * 100 : 0}%"></span>
      </span>
    {/each}
  </div>
  <div class="ticks" aria-hidden="true">
    {#each [0, 6, 12, 18] as h (h)}<span style:left="{(h / 24) * 100}%">{hourTick(h)}</span>{/each}
  </div>
  <p class="readout" aria-live="polite">
    {active === null ? ' ' : `${hourLabel(active)}–${hourLabel(active + 1)}: ${values[active]} ${unit}`}
  </p>
</div>

<style>
  .hb {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-muted);
  }
  .name {
    color: var(--text);
  }
  .cols {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 56px;
    border-bottom: 1px solid var(--border-strong);
  }
  .col {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: flex-end;
    cursor: pointer;
  }
  .bar {
    display: block;
    width: 100%;
    background: var(--viz-series);
    border-radius: 2px 2px 0 0;
  }
  .col.on .bar {
    filter: brightness(1.2);
  }
  .ticks {
    position: relative;
    height: 1.2em;
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .ticks span {
    position: absolute;
  }
  .readout {
    font-size: 12px;
    color: var(--text-muted);
    min-height: 1.4em;
  }
</style>
