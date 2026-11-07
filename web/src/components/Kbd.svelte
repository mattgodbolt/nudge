<script lang="ts">
  import { keyLabels } from '../lib/keys/keymap.svelte';
  /** `keys` is a binding key string like '$mod+Enter' or 'g i'. Or pass `label` for literal text. */
  let { keys, label }: { keys?: string; label?: string } = $props();
  const parts = $derived(label ? [label] : keys ? keyLabels(keys) : []);
</script>

{#each parts as p, i (i)}<kbd>{p}</kbd>{/each}

<style>
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    margin-right: 2px;
    font: 500 11px / 1 var(--font-mono);
    color: var(--text-muted);
    background: var(--bg-hover);
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 4px;
  }
</style>
