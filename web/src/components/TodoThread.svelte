<script lang="ts">
  import { untrack } from 'svelte';
  import type { InboxItem } from '../../../shared/types';
  import { usage } from '../lib/usage';
  import { stateLabel } from '../lib/itemState';
  import { decisions } from '../lib/decisions';
  import { ago } from '../lib/format';
  import { phone } from '../lib/phone.svelte';
  import { formatSnoozeTime, recentlyWoken } from '../lib/snooze';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import ItemActions from './ItemActions.svelte';
  import SnoozeNote from './SnoozeNote.svelte';
  import Icon from './Icon.svelte';
  import Kbd from './Kbd.svelte';

  let { item, now }: { item: InboxItem; now: number } = $props();
  /** "Done", "Dismissed" ... once the item is dealt with; empty while it is in the inbox. */
  const stateText = $derived(stateLabel(item.comment));
  // Each thread is mounted once per open (the parent keys on it), so this counts opens, not renders.
  usage.count('view.todo_thread');
  // Opened now, closed when this thread unmounts or another item takes its place; dwell is measured in between.
  // Keyed on the id, not the row object, which a list refresh replaces: that would close and reopen the record.
  const itemId = $derived(item.comment.id);
  $effect(() =>
    decisions.open(
      itemId,
      untrack(() => inbox.viewName),
    ),
  );

  const it = $derived(item.item);
  // Four buttons are small enough to share the title row in a roomy pane; otherwise they take a row of their own
  // rather than squeezing the title into a narrow column.
  let headerWidth = $state(1000);
  const inline = $derived(headerWidth >= 1500);
  const woke = $derived(!item.snoozedUntil && item.comment.state === 'inbox' && recentlyWoken(item.wokeAt, now));
  const raw = $derived(it.todo?.raw ?? '');
  // Show what was said only when the assistant changed it.
  const showRaw = $derived(raw.trim() !== '' && raw.trim() !== (it.title ?? '').trim());
</script>

<section class="thread" data-testid="thread-view" class:focus={ui.pane === 'thread'} aria-label="Todo">
  <header bind:clientWidth={headerWidth}>
    <button class="btn ghost sm back" onclick={() => (ui.pane = 'list')} aria-label="Back to list"
      ><Icon name="chevron-left" size={phone.value ? 22 : 15} /> Back</button
    >
    <div class="vt">
      <span class="title" data-testid="todo-title">{it.title}</span>
      <div class="meta faint">Todo · added {ago(item.comment.publishedAt, now)}</div>
      <SnoozeNote {item} />
      {#if item.snoozedUntil || woke || stateText}
        <div class="tags">
          {#if stateText}<span class="badge" data-testid="thread-state">{stateText}</span>{/if}
          {#if item.snoozedUntil}
            <span class="snz" data-testid="thread-snoozed"
              >⏰ Due {formatSnoozeTime(item.snoozedUntil, new Date(now))}</span
            >
          {:else if woke}
            <span class="snz" data-testid="thread-woke">⏰ due now</span>
          {/if}
        </div>
      {/if}
    </div>
    <ItemActions {item} width={headerWidth} ownRow={!inline} label="Item actions" />
  </header>

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
  header {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s3) var(--s4);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    min-height: 58px;
    flex-wrap: wrap;
  }
  .vt {
    min-width: 0;
    flex: 1;
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
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    align-items: center;
    margin-top: 4px;
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
