<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { relativeTime } from '../lib/format';
  import Avatar from './Avatar.svelte';

  let {
    item,
    selected,
    checked = false,
    now,
    onclick,
  }: { item: InboxItem; selected: boolean; checked?: boolean; now: number; onclick: () => void } = $props();

  const c = $derived(item.comment);
  const unread = $derived(c.state === 'inbox');
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
      <span class="time faint">{relativeTime(c.publishedAt, now)}</span>
      {#if item.parent}<span class="reply faint truncate">↳ reply to {item.parent.authorName}</span>{/if}
      <span class="spacer"></span>
      {#if item.hasDraft}<span class="draft" title="Draft saved">Draft</span>{/if}
      {#if c.state === 'auto_replied'}<span class="badge" title="Answered on YouTube">Answered</span
        >{:else if c.state === 'replied'}<span class="badge">Replied</span>{/if}
    </div>
    <div class="text">{c.textPlain}</div>
    <div class="video faint truncate">{item.video.title}</div>
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
    font-size: var(--fs-label);
    line-height: 14px;
  }
</style>
