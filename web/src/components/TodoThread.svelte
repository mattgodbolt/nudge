<script lang="ts">
  import { untrack } from 'svelte';
  import type { InboxItem } from '../../../shared/types';
  import { usage } from '../lib/usage';
  import { decisions } from '../lib/decisions';
  import { relativeTime } from '../lib/format';
  import { phone } from '../lib/phone.svelte';
  import { formatSnoozeTime, recentlyWoken } from '../lib/snooze';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import ActionButton from './ActionButton.svelte';
  import Icon from './Icon.svelte';
  import LabelChips from './LabelChips.svelte';

  let { item, now }: { item: InboxItem; now: number } = $props();
  // Each thread is mounted once per open (the parent keys on it), so this counts opens, not renders.
  usage.count('view.todo_thread');
  // Opened now, closed when this thread unmounts or another item takes its place; dwell is measured in between.
  $effect(() =>
    decisions.open(
      item.comment.id,
      untrack(() => inbox.viewName),
    ),
  );

  const it = $derived(item.item);
  const tile = $derived(phone.value);
  const woke = $derived(!item.snoozedUntil && item.comment.state === 'inbox' && recentlyWoken(item.wokeAt, now));
  const raw = $derived(it.todo?.raw ?? '');
  // Show what was said only when the assistant changed it.
  const showRaw = $derived(raw.trim() !== '' && raw.trim() !== (it.title ?? '').trim());
</script>

<section class="thread" data-testid="thread-view" class:focus={ui.pane === 'thread'} aria-label="Todo">
  <header>
    <button class="btn ghost sm back" onclick={() => (ui.pane = 'list')} aria-label="Back to list"
      ><Icon name="chevron-left" size={phone.value ? 22 : 15} /> Back</button
    >
    <div class="vt">
      <span class="title" data-testid="todo-title">{it.title}</span>
      <div class="meta faint">Todo · added {relativeTime(item.comment.publishedAt, now)} ago</div>
      {#if item.snoozedUntil || item.labels.length > 0 || woke}
        <div class="tags">
          {#if item.snoozedUntil}
            <span class="snz" data-testid="thread-snoozed"
              >⏰ Due {formatSnoozeTime(item.snoozedUntil, new Date(now))}</span
            >
          {:else if woke}
            <span class="snz" data-testid="thread-woke">⏰ due now</span>
          {/if}
          <LabelChips ids={item.labels} max={5} />
        </div>
      {/if}
    </div>
    <div class="actions" role="toolbar" aria-label="Item actions" data-testid="thread-actions">
      <ActionButton id="triage.done" label="Done" icon="check" showLabel={!tile} {tile} testid="act-done" />
      {#if item.snoozedUntil}
        <ActionButton id="triage.inbox" label="Unsnooze" icon="inbox" showLabel={!tile} {tile} testid="act-unsnooze" />
      {:else if item.comment.state !== 'inbox'}
        <ActionButton
          id="triage.inbox"
          label="Move back to inbox"
          short="Inbox"
          icon="inbox"
          showLabel={!tile}
          {tile}
          testid="act-inbox"
        />
      {:else}
        <ActionButton id="snooze.open" label="Snooze" icon="clock" showLabel={!tile} {tile} testid="act-snooze" />
      {/if}
      <ActionButton id="label.open" label="Label" icon="tag" showLabel={!tile} {tile} testid="act-label" />
      <ActionButton
        id="triage.undo"
        label="Undo"
        icon="undo"
        showLabel={!tile}
        {tile}
        disabled={inbox.undoDepth === 0}
        testid="act-undo"
      />
    </div>
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
      <kbd class="mono">e</kbd> marks it done, <kbd class="mono">s</kbd> snoozes it. Press <kbd class="mono">c</kbd> and say
      “snooze this till Monday” to do it by voice.
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
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s1);
    flex: none;
    max-width: 100%;
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
  @media (max-width: 899px) {
    .actions {
      width: 100%;
    }
  }
  .notes {
    white-space: pre-wrap;
    margin: 0;
  }
  .said {
    margin: var(--s3) 0 0;
  }
</style>
