<script lang="ts">
  import { tick } from 'svelte';
  import { hideTip, tipState } from '../lib/tip.svelte';

  let el: HTMLDivElement | undefined = $state();
  let pos = $state({ x: 0, y: 0, flip: false });
  const GAP = 8;

  $effect(() => {
    const target = tipState.target;
    void tipState.label;
    if (!target) return;
    void tick().then(() => {
      if (!el || !target.isConnected) return hideTip();
      const r = target.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const flip = r.bottom + GAP + h > window.innerHeight - 4;
      const x = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4);
      pos = { x, y: flip ? r.top - GAP - h : r.bottom + GAP, flip };
    });
  });

  // Anything that moves the target under a visible tooltip dismisses it.
  $effect(() => {
    if (!tipState.target) return;
    const hide = () => hideTip();
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  });
</script>

{#if tipState.target}
  <div bind:this={el} class="tip" role="tooltip" data-testid="tooltip" style:left="{pos.x}px" style:top="{pos.y}px">
    <span>{tipState.label}</span>
    {#each tipState.keys as k, i (i)}<kbd>{k}</kbd>{/each}
  </div>
{/if}

<style>
  .tip {
    position: fixed;
    z-index: 120;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: var(--radius);
    background: var(--text);
    color: var(--bg);
    font-size: var(--fs-label);
    font-weight: 500;
    line-height: 16px;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: var(--shadow-pop);
    animation: tip-in 100ms var(--ease);
  }
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    font: 500 11px / 1 var(--font-mono);
    color: var(--text);
    background: var(--bg);
    border-radius: 3px;
  }
  @keyframes tip-in {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tip {
      animation: none;
    }
  }
</style>
