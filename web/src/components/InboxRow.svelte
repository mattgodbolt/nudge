<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { authorChip, reasonChip, refLabel, statusChip } from '../lib/github';
  import { relativeTime } from '../lib/format';
  import { formatSnoozeTime, recentlyWoken } from '../lib/snooze';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { phone } from '../lib/phone.svelte';
  import ActionButton from './ActionButton.svelte';
  import Avatar from './Avatar.svelte';
  import LabelChips from './LabelChips.svelte';

  let {
    item,
    selected,
    checked = false,
    now,
    showState = false,
    snoozedView = false,
    onclick,
  }: {
    item: InboxItem;
    selected: boolean;
    checked?: boolean;
    now: number;
    /** Label folders and All mix states, so each row says which one it is in. */
    showState?: boolean;
    snoozedView?: boolean;
    onclick: () => void;
  } = $props();

  const c = $derived(item.comment);
  const gh = $derived(item.item.provider === 'github' ? item.item : null);
  const chips = $derived(gh ? [reasonChip(gh), authorChip(gh), statusChip(gh)].filter((x) => x !== null) : []);
  const unread = $derived(c.state === 'inbox' && !item.snoozedUntil);
  const woke = $derived(!item.snoozedUntil && c.state === 'inbox' && recentlyWoken(item.wokeAt, now));
  const stateLabel = $derived(
    c.state === 'done'
      ? 'Done'
      : c.state === 'replied'
        ? 'Replied'
        : c.state === 'auto_replied'
          ? 'Answered'
          : c.state === 'resolved'
            ? 'Closed'
            : '',
  );
</script>

<div
  class="row"
  class:selected
  class:checked
  class:read={!unread}
  data-testid="inbox-row"
  data-comment-id={c.id}
  role="option"
  aria-selected={selected}
  tabindex="-1"
  {onclick}
  onkeydown={() => {}}
>
  <span class="dot" class:on={unread} title={unread ? 'Needs attention' : c.state.replace('_', ' ')}></span>
  <Avatar url={c.authorAvatarUrl} name={c.authorName} />
  <div class="body">
    <div class="top">
      <span class="author truncate">{c.authorName}</span>
      {#if c.isOwn}<span class="badge">You</span>{/if}
      {#each chips as chip (chip.text)}
        <span class="badge chip {chip.tone}" title={chip.title} data-testid="row-chip">{chip.text}</span>
      {/each}
      <span class="time faint">{relativeTime(c.publishedAt, now)}</span>
      {#if item.parent}<span class="reply faint truncate">↳ reply to {item.parent.authorName}</span>{/if}
      <span class="spacer"></span>
      {#if item.snoozedUntil}<span class="snz" data-testid="row-snoozed" title="Snoozed"
          >⏰ until {formatSnoozeTime(item.snoozedUntil, new Date(now))}</span
        >{:else if woke}<span class="snz" data-testid="row-woke">⏰ back from snooze</span>{/if}
      {#if item.hasDraft}<span class="draft" title="Draft saved">Draft</span>{/if}
      {#if c.state === 'auto_replied'}<span class="badge" title="Answered on YouTube">Answered</span
        >{:else if c.state === 'replied'}<span class="badge">Replied</span>{:else if showState && stateLabel}<span
          class="badge"
          data-testid="row-state">{stateLabel}</span
        >{/if}
    </div>
    {#if gh}
      <div class="text gh-title" data-testid="row-title">{gh.title}</div>
    {:else}
      <div class="text">{c.textPlain}</div>
    {/if}
    <div class="video">
      <span class="vtitle faint truncate"
        >{#if gh}<span class="kind" data-testid="row-kind">{gh.kind === 'pr' ? 'PR' : 'Issue'}</span>
          {refLabel(gh)}{:else}{item.video.title}{/if}</span
      >
      {#if gh?.github}
        {#each gh.github.labels.slice(0, 3) as name (name)}<span class="ghlabel">{name}</span>{/each}
      {/if}
      <LabelChips ids={item.labels} />
    </div>
  </div>
  <!-- Positioned over the row's bottom-right, so it never changes row height; acts on THIS row. -->
  <div class="quick" role="group" aria-label="Quick actions">
    {#if snoozedView}
      <ActionButton
        id="triage.inbox"
        label="Unsnooze"
        short="Inbox"
        icon="inbox"
        showLabel={false}
        tile={phone.value}
        tabindex={selected ? 0 : -1}
        onclick={() => void inbox.unsnooze([c.id])}
        testid="row-unsnooze"
      />
    {:else if c.state === 'inbox'}
      <ActionButton
        id="snooze.open"
        label="Snooze"
        icon="clock"
        showLabel={false}
        tile={phone.value}
        tabindex={selected ? 0 : -1}
        onclick={() => ui.openSnooze([c.id])}
        testid="row-snooze"
      />
    {/if}
    <ActionButton
      id="label.open"
      label="Label"
      icon="tag"
      showLabel={false}
      tile={phone.value}
      tabindex={selected ? 0 : -1}
      onclick={() => ui.openLabelPicker([c.id])}
      testid="row-label"
    />
    {#if c.state !== 'done'}
      <ActionButton
        id="triage.done"
        label="Done"
        icon="check"
        showLabel={false}
        tile={phone.value}
        tabindex={selected ? 0 : -1}
        onclick={() => void inbox.triage('done', [c.id])}
        testid="row-done"
      />
    {/if}
    {#if c.state === 'inbox' && !gh}
      <ActionButton
        id="triage.replied"
        label="Mark replied"
        short="Replied"
        icon="check-all"
        showLabel={false}
        tile={phone.value}
        tabindex={selected ? 0 : -1}
        onclick={() => void inbox.triage('replied', [c.id])}
        testid="row-replied"
      />
    {/if}
  </div>
</div>

<style>
  .row {
    height: 100%;
    display: flex;
    gap: var(--s2);
    align-items: flex-start;
    padding: 9px var(--s3) 0 var(--s2);
    border-bottom: 1px solid var(--border);
    cursor: default;
    position: relative;
    transition: background var(--dur) var(--ease);
    overflow: hidden;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .row.selected {
    background: var(--bg-selected);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .row.checked {
    background: var(--accent-soft);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-top: 9px;
    flex: none;
    background: transparent;
  }
  .dot.on {
    background: var(--accent);
  }
  .body {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .top {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: var(--fs-meta);
    line-height: 18px;
    min-width: 0;
  }
  .author {
    font-weight: 600;
    max-width: 55%;
  }
  .read .author {
    font-weight: 500;
    color: var(--text-muted);
  }
  .time {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .reply {
    font-size: var(--fs-label);
  }
  .spacer {
    flex: 1;
  }
  .draft {
    font-size: 11px;
    color: var(--secondary);
    font-weight: 600;
  }
  .text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 18px;
    height: 36px;
    overflow-wrap: anywhere;
  }
  .read .text {
    color: var(--text-muted);
  }
  .video {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-label);
    line-height: 14px;
    padding-right: 104px; /* room for the quick actions */
    min-width: 0;
  }
  .vtitle {
    min-width: 0;
    flex: 0 1 auto;
  }
  .snz {
    flex: none;
    font-size: 11px;
    color: var(--secondary);
    white-space: nowrap;
  }
  .quick {
    position: absolute;
    right: var(--s2);
    bottom: 3px;
    display: flex;
    gap: 2px;
    padding: 1px;
    border-radius: var(--radius);
    background: var(--bg-elev);
    box-shadow: 0 0 0 1px var(--border);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--dur) var(--ease);
  }
  .quick :global(.btn) {
    height: 20px;
  }
  .row:hover .quick,
  .quick:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
  /* Touch and narrow layouts have no hover: always show them. */
  @media (hover: none), (max-width: 899px) {
    .quick {
      opacity: 1;
      pointer-events: auto;
    }
  }
  /* Phone: actions get their own full-width row of big equal tiles under the text, so nothing overlaps. */
  @media (max-width: 899px) {
    .row {
      flex-wrap: wrap;
      align-content: flex-start;
      padding: 10px var(--s3) 8px;
    }
    .video {
      padding-right: 0;
    }
    .author {
      max-width: 45%;
    }
    .quick {
      position: static;
      order: 9;
      flex: 1 0 100%;
      gap: var(--s2);
      margin-top: var(--s2);
      padding: 0;
      background: none;
      box-shadow: none;
    }
    .quick :global(.btn.action.tile) {
      height: auto;
      flex: 1 1 0;
      min-height: 52px;
      flex-direction: row;
      gap: 6px;
    }
    .quick :global(.btn.action .lbl) {
      font-size: var(--fs-meta);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .quick {
      transition: none;
    }
  }
  @media (max-width: 400px) {
    .quick {
      gap: 6px;
    }
    .quick :global(.btn.action.tile) {
      padding: 0 2px;
      gap: 4px;
      min-width: 0;
    }
    .quick :global(.btn.action .lbl) {
      font-size: var(--fs-label);
    }
  }
  .gh-title {
    font-weight: 500;
  }
  .chip.accent {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
  }
  .chip.muted {
    opacity: 0.75;
  }
  .kind {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 0 5px;
    margin-right: 4px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    text-transform: uppercase;
  }
  .ghlabel {
    font-size: var(--fs-meta);
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 7px;
    white-space: nowrap;
  }
</style>
