<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { suggestedButton } from '../lib/itemState';
  import { phone } from '../lib/phone.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import ActionButton from './ActionButton.svelte';

  /**
   * The open item's toolbar, shared by the YouTube, GitHub and todo threads. Two groups so it reads at a glance:
   *  - Decide: what the owner does to nearly every item (Reply, Done, No action needed, Mark replied, Snooze). Always
   *    labelled while there is room, and the one the suggestion points at wears a quiet ring.
   *  - Tools: rarer, or not decisions at all (Label, Mute, Undo, Open on the site). Icon-only, tooltipped, in a
   *    subtle cluster, so they stay one click away without competing for the width the labels need.
   */
  let {
    item,
    width,
    ownRow,
    label = 'Item actions',
  }: {
    item: InboxItem;
    /** Width of the header the toolbar lives in: decides how much of each label fits. */
    width: number;
    /** The toolbar has a row to itself (the usual case); false when it shares the title's row in a very wide pane. */
    ownRow: boolean;
    label?: string;
  } = $props();

  const provider = $derived(item.item.provider);
  const tile = $derived(phone.value);
  // Labels: full names in a roomy pane, short ones in a middling one, icons only when squeezed. Phone tiles carry
  // their own short labels.
  const labelled = $derived(!tile && width >= 420);
  const long = $derived(width >= 900);
  const suggested = $derived(suggestedButton(item, 'thread'));
  const site = $derived(provider === 'github' ? 'GitHub' : 'YouTube');
</script>

<div class="actions" class:own-row={ownRow} class:tile role="toolbar" aria-label={label} data-testid="thread-actions">
  <div class="group decide" role="group" aria-label="Decide">
    {#if provider === 'youtube'}
      <ActionButton
        id="reply.open"
        label="Reply"
        icon="reply"
        showLabel={labelled}
        {tile}
        suggested={suggested === 'reply.open'}
        testid="act-reply"
      />
    {/if}
    <ActionButton
      id="triage.done"
      label="Done"
      icon="check"
      showLabel={labelled}
      {tile}
      suggested={suggested === 'triage.done'}
      testid="act-done"
    />
    <ActionButton
      id="triage.dismiss"
      label="No action needed"
      short="No action"
      compact={!long}
      icon="dismiss"
      showLabel={labelled}
      {tile}
      suggested={suggested === 'triage.dismiss'}
      testid="act-dismiss"
    />
    {#if provider !== 'todo'}
      <ActionButton
        id="triage.replied"
        label="Mark replied"
        short="Replied"
        compact={!long}
        icon="check-all"
        showLabel={labelled}
        {tile}
        suggested={suggested === 'triage.replied'}
        testid="act-replied"
      />
    {/if}
    {#if item.snoozedUntil}
      <ActionButton id="triage.inbox" label="Unsnooze" icon="inbox" showLabel={labelled} {tile} testid="act-unsnooze" />
    {:else if item.comment.state !== 'inbox'}
      <ActionButton
        id="triage.inbox"
        label="Move back to inbox"
        short="Inbox"
        icon="inbox"
        showLabel={labelled}
        {tile}
        testid="act-inbox"
      />
    {:else}
      <ActionButton
        id="snooze.open"
        label="Snooze"
        icon="clock"
        showLabel={labelled}
        {tile}
        suggested={suggested === 'snooze.open'}
        testid="act-snooze"
      />
    {/if}
  </div>
  <div class="group tools" role="group" aria-label="Tools">
    <ActionButton id="label.open" label="Label" icon="tag" showLabel={false} {tile} short="Label" testid="act-label" />
    {#if provider === 'github'}
      <ActionButton id="mute.open" label="Mute" icon="x" showLabel={false} {tile} short="Mute" testid="act-mute" />
    {/if}
    <ActionButton
      id="triage.undo"
      label="Undo"
      icon="undo"
      showLabel={false}
      {tile}
      short="Undo"
      disabled={inbox.undoDepth === 0}
      testid="act-undo"
    />
    {#if provider !== 'todo'}
      <ActionButton
        id="open.comment"
        label="Open on {site}"
        short="Open"
        icon="external"
        showLabel={false}
        {tile}
        testid="act-open"
      />
    {/if}
  </div>
</div>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2) var(--s3);
    flex: none;
    max-width: 100%;
  }
  .actions.own-row {
    flex-basis: 100%;
  }
  .group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
  }
  /* The tools sit apart, to the right on a roomy row, in a quiet cluster of their own. */
  .tools {
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) + 2px);
    background: var(--bg);
  }
  .own-row .tools {
    margin-left: auto;
  }
  /* Phone: the decisions are four or five big equal tiles; the tools are a second, shallower row of the same width. */
  @media (max-width: 899px) {
    .actions {
      width: 100%;
      flex-direction: column;
      align-items: stretch;
      gap: var(--s2);
    }
    .group {
      width: 100%;
      gap: var(--s2);
    }
    .group :global(.action.tile) {
      flex: 1 1 0;
      min-width: 0;
      padding: 6px 2px;
    }
    .tools {
      padding: 0;
      border: 0;
      background: none;
    }
    .tools :global(.action.tile) {
      min-height: 44px;
      height: 44px;
      flex-direction: row;
      gap: 6px;
    }
    .tools :global(.action.tile .lbl),
    .decide :global(.action.tile .lbl) {
      font-size: var(--fs-label);
    }
  }
</style>
