<script lang="ts">
  import type { Snippet } from 'svelte';
  let { title, body, children }: { title: string; body?: string; children?: Snippet } = $props();
</script>

<div class="empty">
  <h2>{title}</h2>
  {#if body}<p class="muted">{body}</p>{/if}
  {#if children}<div class="extra">{@render children()}</div>{/if}
</div>

<style>
  .empty {
    margin: auto;
    max-width: 440px;
    padding: var(--s6) var(--s4);
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    align-items: center;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  p {
    font-size: var(--fs-meta);
    line-height: 1.55;
  }
  .extra {
    margin-top: var(--s3);
    width: 100%;
  }
</style>
