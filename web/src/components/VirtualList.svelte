<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { PULL_THRESHOLD, PullTracker } from '../lib/pull';
  import Icon from './Icon.svelte';

  interface Props {
    items: T[];
    rowHeight: number;
    /** Rows of a different height (section headings): the height of one item, when it is not `rowHeight`. */
    heightOf?: (item: T) => number;
    selectedIndex: number;
    onNearEnd?: () => void;
    row: Snippet<[T, number]>;
    key?: (item: T) => string;
    overscan?: number;
    /** Pull down at the top of the list to run this (touch only). */
    onRefresh?: () => Promise<void> | void;
  }
  let { items, rowHeight, heightOf, selectedIndex, onNearEnd, row, key, overscan = 10, onRefresh }: Props = $props();

  let viewport: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let height = $state(600);

  // Where each row starts (and the total at the end). Uniform lists need no table.
  const offsets = $derived.by(() => {
    if (!heightOf) return null;
    const o = new Array<number>(items.length + 1);
    o[0] = 0;
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i]! + heightOf(items[i]!);
    return o;
  });
  const topOf = (i: number): number => (offsets ? offsets[i]! : i * rowHeight);
  const heightAt = (i: number): number => (heightOf ? heightOf(items[i]!) : rowHeight);
  const totalHeight = $derived(offsets ? offsets[items.length]! : items.length * rowHeight);
  /** The row covering vertical position y. */
  function indexAt(y: number): number {
    if (!offsets) return Math.floor(y / rowHeight);
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1]! <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const start = $derived(Math.max(0, indexAt(scrollTop) - overscan));
  const end = $derived(Math.min(items.length, indexAt(scrollTop + height) + 1 + overscan));
  const visible = $derived(items.slice(start, end).map((item, i) => ({ item, index: start + i })));

  // Keep the cursor visible (block: "nearest" semantics).
  $effect(() => {
    const idx = selectedIndex;
    const el = viewport;
    if (!el || idx < 0) return;
    const top = topOf(idx);
    const bottom = top + heightAt(idx);
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  });

  // Pull to refresh. touchmove has to be non-passive so a pull can stop the browser scrolling or overscrolling.
  // Move/end listeners go on the element the finger first touched, not the list: if a live update removes that row
  // mid-gesture, the rest of the gesture is delivered to the detached row and would never bubble up to the list,
  // leaving the pull stuck half-way.
  const HOLD = 52; // where the list rests while refreshing
  const tracker = new PullTracker();
  let pull = $state(0);
  let settling = $state(false);
  let refreshing = $state(false);
  $effect(() => {
    const el = viewport;
    if (!el || !onRefresh) return;
    let target: EventTarget | null = null;
    const detach = () => {
      target?.removeEventListener('touchmove', onMove as EventListener);
      target?.removeEventListener('touchend', onEnd);
      target?.removeEventListener('touchcancel', onEnd);
      target = null;
    };
    const onMove = (e: TouchEvent) => {
      if (refreshing || e.touches.length !== 1) return;
      const d = tracker.move(e.touches[0]!.clientX, e.touches[0]!.clientY);
      if (tracker.pulling) {
        if (e.cancelable) e.preventDefault();
        pull = d;
      }
    };
    const onEnd = () => {
      detach();
      if (!tracker.pulling) return void tracker.end();
      const fire = tracker.end();
      settling = true;
      if (!fire) {
        pull = 0;
        return;
      }
      pull = HOLD;
      refreshing = true;
      void Promise.resolve(onRefresh()).finally(() => {
        refreshing = false;
        pull = 0;
      });
    };
    const onStart = (e: TouchEvent) => {
      detach();
      if (e.touches.length !== 1 || refreshing) return;
      settling = false;
      tracker.start(e.touches[0]!.clientX, e.touches[0]!.clientY, el.scrollTop);
      target = e.target;
      target!.addEventListener('touchmove', onMove as EventListener, { passive: false });
      target!.addEventListener('touchend', onEnd);
      target!.addEventListener('touchcancel', onEnd);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      detach();
    };
  });

  // For bug reports about overlapping rows: run `__nudgeDebugList()` in the dev tools console while it is wrong. If the
  // keys are unique and each slot's recorded offset equals its painted one, the DOM is right and the fault is painting.
  $effect(() => {
    const w = window as unknown as { __nudgeDebugList?: () => unknown };
    w.__nudgeDebugList = () => {
      const keys = items.map((it, i) => (key ? key(it) : String(i)));
      const slots = [...(viewport?.querySelectorAll<HTMLElement>('.slot') ?? [])].map((el) => ({
        transform: el.style.transform,
        top: Math.round(el.getBoundingClientRect().top),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      }));
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      const out = { count: items.length, scrollTop, height, start, end, dupes, keys: keys.slice(start, end), slots };
      console.log(JSON.stringify(out, null, 1));
      return out;
    };
    return () => {
      delete w.__nudgeDebugList;
    };
  });

  $effect(() => {
    if (onNearEnd && items.length > 0 && end >= items.length - 20) onNearEnd();
  });
</script>

<div class="wrap">
  {#if onRefresh}
    <div
      class="ptr"
      class:armed={pull >= PULL_THRESHOLD}
      class:spin={refreshing}
      style:opacity={refreshing ? 1 : Math.min(1, pull / PULL_THRESHOLD)}
      data-testid="pull-indicator"
      aria-hidden="true"
    >
      <Icon name="refresh" size={22} />
    </div>
  {/if}
  <div
    class="viewport"
    class:settling
    style:transform={pull > 0 ? `translateY(${pull}px)` : undefined}
    bind:this={viewport}
    bind:clientHeight={height}
    onscroll={() => (scrollTop = viewport?.scrollTop ?? 0)}
    role="listbox"
    tabindex="-1"
    aria-label="Comments"
  >
    <div class="spacer" style:height="{totalHeight}px">
      {#each visible as { item, index } (key ? key(item) : index)}
        <div class="slot" style:transform="translateY({topOf(index)}px)" style:height="{heightAt(index)}px">
          {@render row(item, index)}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .wrap {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .viewport {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    position: relative;
    contain: strict;
    overscroll-behavior-y: contain;
  }
  .viewport.settling {
    transition: transform 180ms var(--ease);
  }
  .ptr {
    position: absolute;
    top: 0;
    left: 50%;
    width: 44px;
    height: 44px;
    margin: 4px 0 0 -22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text-muted);
    pointer-events: none;
    z-index: 0;
  }
  .ptr.armed {
    color: var(--accent);
  }
  .ptr.spin :global(svg) {
    animation: ptr-spin 0.9s linear infinite;
  }
  @keyframes ptr-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .spacer {
    position: relative;
    width: 100%;
  }
  .slot {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
  }
</style>
