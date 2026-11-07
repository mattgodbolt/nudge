<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';

  interface Props {
    items: T[];
    rowHeight: number;
    selectedIndex: number;
    onNearEnd?: () => void;
    row: Snippet<[T, number]>;
    key?: (item: T) => string;
    overscan?: number;
  }
  let { items, rowHeight, selectedIndex, onNearEnd, row, key, overscan = 10 }: Props = $props();

  let viewport: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let height = $state(600);

  const start = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = $derived(Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan));
  const visible = $derived(items.slice(start, end).map((item, i) => ({ item, index: start + i })));

  // Keep the cursor visible (block: "nearest" semantics).
  $effect(() => {
    const idx = selectedIndex;
    const el = viewport;
    if (!el || idx < 0) return;
    const top = idx * rowHeight;
    const bottom = top + rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  });

  $effect(() => {
    if (onNearEnd && items.length > 0 && end >= items.length - 20) onNearEnd();
  });
</script>

<div
  class="viewport"
  bind:this={viewport}
  bind:clientHeight={height}
  onscroll={() => (scrollTop = viewport?.scrollTop ?? 0)}
  role="listbox"
  tabindex="-1"
  aria-label="Comments"
>
  <div class="spacer" style:height="{items.length * rowHeight}px">
    {#each visible as { item, index } (key ? key(item) : index)}
      <div class="slot" style:transform="translateY({index * rowHeight}px)" style:height="{rowHeight}px">
        {@render row(item, index)}
      </div>
    {/each}
  </div>
</div>

<style>
  .viewport {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    position: relative;
    contain: strict;
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
