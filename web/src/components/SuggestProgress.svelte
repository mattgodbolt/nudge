<script lang="ts">
  import { suggestStatus } from '../lib/stores/suggestStatus.svelte';
  import { progressLine } from '../lib/suggestions';

  const line = $derived(progressLine(suggestStatus.value));
</script>

{#if line}
  <p class="faint meta progress" data-testid="suggest-progress" aria-live="polite">{line}</p>
{/if}

<style>
  .progress {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
