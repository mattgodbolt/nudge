<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { ago } from '../lib/format';
  import { ui } from '../lib/stores/ui.svelte';
  import ThreadHeader from './ThreadHeader.svelte';
  import Kbd from './Kbd.svelte';

  let { item, now }: { item: InboxItem; now: number } = $props();
  const it = $derived(item.item);
  const raw = $derived(it.todo?.raw ?? '');
  // Show what was said only when the assistant changed it.
  const showRaw = $derived(raw.trim() !== '' && raw.trim() !== (it.title ?? '').trim());
</script>

<section class="thread" data-testid="thread-view" class:focus={ui.pane === 'thread'} aria-label="Todo">
  <!-- Four buttons are small enough to share the title row in a roomy pane. -->
  <ThreadHeader
    {item}
    {now}
    view="view.todo_thread"
    actionsLabel="Item actions"
    inlineFrom={1500}
    snoozedText={(when) => `Due ${when}`}
    wokeText="due now"
  >
    {#snippet title()}
      <span class="title" data-testid="todo-title">{it.title}</span>
    {/snippet}
    {#snippet meta()}
      <div class="meta faint">Todo · added {ago(item.comment.publishedAt, now)}</div>
    {/snippet}
  </ThreadHeader>

  <div class="scroll">
    <article class="card" data-testid="todo-body">
      {#if item.comment.textPlain}
        <p class="notes">{item.comment.textPlain}</p>
      {:else}
        <p class="faint">No notes.</p>
      {/if}
      {#if showRaw}
        <p class="faint meta said" data-testid="todo-said">You said: “{raw}”</p>
      {/if}
    </article>
    <p class="faint meta hint">
      <span class="keys-only"
        ><Kbd id="triage.done" /> marks it done, <Kbd id="snooze.open" /> snoozes it. Press
        <Kbd id="assistant.open" /> and say “snooze this till Monday” to do it by voice.</span
      >
      <span class="touch-only">Use the buttons above, or tap the mic and say “snooze this till Monday”.</span>
    </p>
  </div>
</section>

<style>
  .thread {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    flex: 1;
    background: var(--bg);
  }
  .title {
    display: block;
    font-weight: 600;
    color: var(--text);
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .title:hover {
    text-decoration: underline;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s4);
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elev);
    padding: var(--s3) var(--s4);
  }
  .hint {
    margin: 0;
  }
  .notes {
    white-space: pre-wrap;
    margin: 0;
  }
  .said {
    margin: var(--s3) 0 0;
  }
</style>
