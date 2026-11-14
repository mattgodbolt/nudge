<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { copyOnly } from '../lib/reply';
  import { nudge } from '../lib/stores/nudge.svelte';
  import { usage } from '../lib/usage';

  /** The drafted nudge for this item, in a box with a Copy button. Never posted: the owner pastes it on GitHub. */
  let { item }: { item: InboxItem } = $props();

  const text = $derived(nudge.itemId === item.item.id ? nudge.text : null);

  function copy() {
    if (!text) return;
    usage.count('nudge.copy');
    copyOnly(text);
  }
</script>

{#if text}
  <section class="nudge" aria-label="Drafted nudge" data-testid="nudge-box">
    <div class="head faint meta">Drafted nudge · not posted anywhere, paste it on GitHub yourself</div>
    <div class="draft" data-testid="nudge-text">{text}</div>
    <div class="actions">
      <button class="btn sm primary" data-testid="nudge-copy" onclick={copy}>Copy</button>
    </div>
  </section>
{/if}

<style>
  .nudge {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    padding: var(--s3);
    margin-bottom: var(--s3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elev);
  }
  .draft {
    padding: var(--s2) var(--s3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  @media (max-width: 899px) {
    .actions .btn {
      min-height: 44px;
      min-width: 96px;
    }
  }
</style>
