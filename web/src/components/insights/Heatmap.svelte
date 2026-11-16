<script lang="ts">
  import type { WeekGrid } from '../../../../shared/insights';
  import { WEEKDAYS, WEEKDAYS_SHORT, heatLevel, hourLabel, hourTick, perDayLabel } from '../../lib/insights';

  // A 7×24 week of hours in one sequential hue: the value is the average per such weekday in the range. Desktop has
  // weekdays down and hours across; under 640px it turns (hours down the page, weekdays across) so cells stay
  // readable. Tap or hover a cell for its numbers in the shared line underneath; the table view has them all.
  let { grid, unit, label }: { grid: WeekGrid; unit: string; label: string } = $props();

  /** Monday first. */
  const ORDER = [1, 2, 3, 4, 5, 6, 0];
  const max = $derived(Math.max(0, ...grid.perDay.flat()));
  let active = $state<{ wd: number; h: number } | null>(null);
  const readout = $derived.by(() => {
    if (!active) return `Tap a square for its numbers.`;
    const c = grid.counts[active.wd]![active.h]!;
    const per = grid.perDay[active.wd]![active.h]!;
    return `${WEEKDAYS[active.wd]} ${hourLabel(active.h)}–${hourLabel(active.h + 1)}: ${perDayLabel(per)} ${unit} a ${WEEKDAYS[active.wd]} (${c} in all)`;
  });
  const summary = $derived(
    grid.peak
      ? `${label}. Busiest: ${WEEKDAYS[grid.peak.weekday]} ${hourLabel(grid.peak.hour)}, ${perDayLabel(grid.peak.perDay)} ${unit} per day.`
      : label,
  );
</script>

<div class="heat">
  <div class="grid" role="img" aria-label={summary} data-testid="heatmap">
    {#each ORDER as wd, r (wd)}
      <span class="rowlabel" style:--r={r} style:--c={-1}>{WEEKDAYS_SHORT[wd]}</span>
    {/each}
    {#each [0, 6, 12, 18] as h (h)}
      <span class="tick" style:--r={-1} style:--c={h}>{hourTick(h)}</span>
    {/each}
    {#each ORDER as wd, r (wd)}
      {#each grid.perDay[wd]! as v, h (h)}
        <span
          class="cell l{heatLevel(v, max)}"
          class:on={active?.wd === wd && active?.h === h}
          style:--r={r}
          style:--c={h}
          onpointerenter={() => (active = { wd, h })}
          onclick={() => (active = { wd, h })}
          role="presentation"
        ></span>
      {/each}
    {/each}
  </div>
  <div class="foot">
    <p class="readout" aria-live="polite">{readout}</p>
    <span class="legend" aria-hidden="true">
      <span>0</span>
      {#each [1, 2, 3, 4, 5, 6, 7] as l (l)}<span class="sw l{l}"></span>{/each}
      <span>{perDayLabel(max)}/day</span>
    </span>
  </div>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: 2.4em repeat(24, minmax(0, 1fr));
    grid-template-rows: 1.2em repeat(7, minmax(14px, 22px));
    gap: 2px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .grid > span {
    grid-row: calc(var(--r) + 2);
    grid-column: calc(var(--c) + 2);
  }
  .rowlabel {
    align-self: center;
  }
  .tick {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .cell {
    border-radius: 2px;
    background: var(--viz-empty);
    cursor: pointer;
  }
  .cell.on {
    outline: 2px solid var(--text);
    outline-offset: -1px;
  }
  .l1 {
    background: var(--viz-seq-1);
  }
  .l2 {
    background: var(--viz-seq-2);
  }
  .l3 {
    background: var(--viz-seq-3);
  }
  .l4 {
    background: var(--viz-seq-4);
  }
  .l5 {
    background: var(--viz-seq-5);
  }
  .l6 {
    background: var(--viz-seq-6);
  }
  .l7 {
    background: var(--viz-seq-7);
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2) var(--s3);
    margin-top: var(--s2);
  }
  .readout {
    flex: 1 1 14em;
    font-size: 12px;
    color: var(--text-muted);
    min-height: 1.4em;
  }
  .legend {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .legend > span:first-child {
    margin-right: 4px;
  }
  .legend > span:last-child {
    margin-left: 4px;
  }
  .sw {
    width: 12px;
    height: 10px;
    border-radius: 2px;
  }
  /* Phone: hours run down the page, weekdays across, so each cell stays at least 12px wide. */
  @media (max-width: 639px) {
    .grid {
      grid-template-columns: 2.4em repeat(7, minmax(12px, 1fr));
      grid-template-rows: 1.4em repeat(24, 14px);
    }
    .grid > span {
      grid-row: calc(var(--c) + 2);
      grid-column: calc(var(--r) + 2);
    }
    .tick {
      align-self: center;
    }
    .rowlabel {
      text-align: center;
    }
  }
</style>
