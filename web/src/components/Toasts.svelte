<script lang="ts">
  import { toasts } from '../lib/stores/toasts.svelte';
  import { fly } from 'svelte/transition';
</script>

<!-- One polite live region for the stack; an error is an alert of its own (no per-toast status: read twice). -->
<div class="stack" aria-live="polite">
  {#each toasts.items as t (t.id)}
    <div
      class="toast {t.kind}"
      data-testid="toast"
      role={t.kind === 'error' ? 'alert' : undefined}
      transition:fly={{ y: 12, duration: 120 }}
    >
      <span class="msg">{t.message}</span>
      {#if t.action}
        <button
          class="act"
          onclick={() => {
            t.action?.run();
            toasts.dismiss(t.id);
          }}>{t.action.label}</button
        >
      {/if}
      <button class="close" aria-label="Dismiss" onclick={() => toasts.dismiss(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    bottom: var(--s4);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    z-index: 100;
    pointer-events: none;
    width: max-content;
    max-width: calc(100vw - 32px);
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: 8px 8px 8px var(--s4);
    background: var(--text);
    color: var(--bg);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
    font-size: var(--fs-meta);
  }
  .toast.error {
    background: var(--danger);
    color: #fff;
  }
  .act {
    border: 0;
    background: color-mix(in srgb, var(--bg) 20%, transparent);
    color: inherit;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .act:hover {
    background: color-mix(in srgb, var(--bg) 32%, transparent);
  }
  .close {
    border: 0;
    background: transparent;
    color: inherit;
    opacity: 0.6;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 2px 6px;
  }
  .close:hover {
    opacity: 1;
  }
  @media (max-width: 899px) {
    .stack {
      bottom: calc(var(--s3) + env(safe-area-inset-bottom));
      width: calc(100vw - 24px);
      max-width: none;
    }
    .toast {
      padding: 4px 4px 4px var(--s4);
      min-height: 56px;
      font-size: var(--fs-base);
    }
    .act,
    .close {
      min-width: 56px;
      min-height: 48px;
      padding: 0 var(--s3);
      touch-action: manipulation;
    }
    .close {
      font-size: 22px;
    }
  }
</style>
