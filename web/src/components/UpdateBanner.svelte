<script lang="ts">
  import { update } from '../lib/stores/update.svelte';
  import Icon from './Icon.svelte';

  // Esc works while focus is in the banner (a global Esc is already spoken for: it clears the selection, backs out of
  // panes and closes menus).
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      update.dismiss();
    }
  }
</script>

{#if update.visible}
  <!-- Esc is handled for focus anywhere inside the banner, which is why the handler sits on the container. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="update" role="status" aria-label="New version" data-testid="update-banner" onkeydown={key}>
    <span class="msg">New version available</span>
    <span class="dot" aria-hidden="true">·</span>
    <button type="button" class="btn sm" data-testid="update-reload" onclick={() => update.reload()}>Reload</button>
    <span class="grow"></span>
    <button
      type="button"
      class="btn sm ghost icon"
      data-testid="update-dismiss"
      aria-label="Not now"
      title="Not now (Esc)"
      onclick={() => update.dismiss()}><Icon name="x" size={14} /></button
    >
  </div>
{/if}

<style>
  .update {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: 4px var(--s4);
    font-size: var(--fs-meta);
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
    color: var(--text);
  }
  .dot {
    color: var(--text-muted);
  }
  .grow {
    flex: 1;
  }
  .icon {
    width: 28px;
    padding: 0;
    justify-content: center;
  }
  @media (max-width: 899px) {
    .update {
      padding: 4px var(--s3);
    }
    .update :global(.btn) {
      min-height: 40px;
    }
    .icon {
      width: 40px;
    }
  }
</style>
