<script lang="ts">
  import { hotkey, keyLabels } from '../lib/keys/keymap.svelte';
  /** `keys` is a binding key string like '$mod+Enter' or 'g i'. Or pass `label` for literal text. */
  /** Or `id` to show a binding's primary key straight from the keymap registry. */
  let { keys, label, id }: { keys?: string; label?: string; id?: string } = $props();
  const k = $derived(keys ?? (id ? hotkey(id) : undefined));
  const parts = $derived(label ? [label] : k ? keyLabels(k) : []);
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
