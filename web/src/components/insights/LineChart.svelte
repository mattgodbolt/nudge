<script lang="ts">
  import { dayLabel } from '../../lib/insights';

  // One series over days: a 2px line on a hairline baseline, the last value labelled at its end dot. Hover or tap
  // anywhere along it: a hairline snaps to the nearest day and the line underneath says its value.
  let { points, unit, label }: { points: { day: string; count: number }[]; unit: string; label: string } = $props();

  const W = 600;
  const H = 120;
  const PAD = { top: 10, right: 60, bottom: 6, left: 6 };
  const max = $derived(Math.max(1, ...points.map((p) => p.count)));
  const xAt = (i: number) =>
    PAD.left + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - PAD.left - PAD.right));
  const yAt = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const path = $derived(points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.count).toFixed(1)}`).join(' '));
  let active = $state<number | null>(null);
  let svg: SVGSVGElement | undefined = $state();

  function pick(e: PointerEvent) {
    if (!svg || points.length === 0) return;
    const r = svg.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((fx - PAD.left) / (W - PAD.left - PAD.right)) * (points.length - 1));
    active = Math.max(0, Math.min(points.length - 1, i));
  }
  const last = $derived(points[points.length - 1]);
  const activePoint = $derived(active === null ? undefined : points[active]);
</script>

<div class="lc">
  <svg
    bind:this={svg}
    viewBox="0 0 {W} {H}"
    preserveAspectRatio="none"
    role="img"
    aria-label="{label}: from {points[0]?.count ?? 0} on {points[0] ? dayLabel(points[0].day) : ''} to {last?.count ??
      0} on {last ? dayLabel(last.day) : ''}, at most {max}"
    onpointermove={pick}
    onpointerdown={pick}
    data-testid="linechart"
  >
    <line class="base" x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} />
    <line class="grid" x1={PAD.left} x2={W - PAD.right} y1={PAD.top} y2={PAD.top} />
    {#if active !== null}
      <line class="cross" x1={xAt(active)} x2={xAt(active)} y1={PAD.top} y2={H - PAD.bottom} />
    {/if}
    <polyline class="line" points={path} />
  </svg>
  {#if last}
    <span class="dot" style:left="{(xAt(points.length - 1) / W) * 100}%" style:top="{(yAt(last.count) / H) * 120}px"
    ></span>
    <span
      class="end"
      style:left="calc({(xAt(points.length - 1) / W) * 100}% + 8px)"
      style:top="{(yAt(last.count) / H) * 120}px">{last.count}</span
    >
  {/if}
  {#if !last || yAt(last.count) - yAt(max) > 16}<span class="max">{max}</span>{/if}
  <div class="axis" aria-hidden="true">
    <span>{points[0] ? dayLabel(points[0].day) : ''}</span>
    <span>{last ? dayLabel(last.day) : ''}</span>
  </div>
  <p class="readout" aria-live="polite">
    {activePoint
      ? `${dayLabel(activePoint.day)}: ${activePoint.count} ${unit}`
      : 'Hover or tap along the line for a day.'}
  </p>
</div>

<style>
  .lc {
    position: relative;
  }
  svg {
    display: block;
    width: 100%;
    height: 120px;
    touch-action: pan-y;
  }
  .line {
    fill: none;
    stroke: var(--viz-series);
    stroke-width: 2px;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }
  .base {
    stroke: var(--border-strong);
    stroke-width: 1px;
    vector-effect: non-scaling-stroke;
  }
  .grid,
  .cross {
    stroke: var(--viz-grid);
    stroke-width: 1px;
    vector-effect: non-scaling-stroke;
  }
  .cross {
    stroke: var(--text-muted);
  }
  .end,
  .max {
    position: absolute;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    transform: translateY(-50%);
  }
  .max {
    right: 0;
    top: 10px;
    color: var(--text-muted);
  }
  .dot {
    position: absolute;
    width: 8px;
    height: 8px;
    margin: -4px 0 0 -4px;
    border-radius: 50%;
    background: var(--viz-series);
    box-shadow: 0 0 0 2px var(--bg-elev);
    pointer-events: none;
  }
  .end {
    color: var(--text);
    font-weight: 600;
  }
  .axis {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--text-muted);
  }
  .readout {
    font-size: 12px;
    color: var(--text-muted);
    min-height: 1.4em;
  }
</style>
