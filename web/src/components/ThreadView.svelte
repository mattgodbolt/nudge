<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { thread } from '../lib/stores/thread.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { pluralize } from '../lib/format';
  import ThreadHeader from './ThreadHeader.svelte';
  import CommentCard from './CommentCard.svelte';
  import Composer from './Composer.svelte';
  import { tick, untrack } from 'svelte';

  let { item, now }: { item: InboxItem; now: number } = $props();
  // Read through a derived so the effects below follow the item, not the row object (a list refresh replaces it).
  const itemId = $derived(item.comment.id);
  let scroller: HTMLDivElement | undefined = $state();
  const detail = $derived(thread.current && thread.current.threadId === item.comment.threadId ? thread.current : null);
  const notFetched = $derived(detail ? Math.max(0, detail.totalReplyCount - (detail.comments.length - 1)) : 0);
  const video = $derived(detail?.video ?? null);

  // Bring the focused comment into view when the thread or focus changes, but not when a live update swaps in a
  // fresh copy of the same thread: that would yank the reader back from wherever they had scrolled to.
  let scrolledTo = '';
  $effect(() => {
    const cid = itemId;
    const tid = detail?.threadId;
    if (!tid) return;
    const key = `${tid}\n${cid}`;
    if (key === scrolledTo) return;
    scrolledTo = key;
    void tick().then(() => {
      const el = scroller?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(cid)}"]`);
      if (el && scroller) {
        const top = el.offsetTop - 80;
        scroller.scrollTop = Math.max(0, top);
      }
    });
  });

  // j/k in thread scope scrolls.
  $effect(() => {
    const { delta, tick: t } = ui.threadScroll;
    if (t === 0) return;
    untrack(() => scroller?.scrollBy({ top: delta * 80, behavior: 'smooth' }));
  });
</script>

<section class="thread" data-testid="thread-view" class:focus={ui.pane === 'thread'} aria-label="Thread">
  <!-- Actions share the title row only in a roomy pane; otherwise they take a row of their own,
    and drop their labels (still tooltipped) when even that row is too narrow. -->
  <ThreadHeader
    {item}
    {now}
    view="view.thread"
    actionsLabel="Comment actions"
    inlineFrom={1500}
    showSuggestion
    chrome
    snoozedText={(when) => `Snoozed until ${item.snoozeUntilActivity ? 'activity, or ' : ''}${when}`}
    wokeText="back from snooze"
  >
    {#snippet lead()}
      {#if item.video.thumbnailUrl}
        <img class="thumb" src={item.video.thumbnailUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
      {/if}
    {/snippet}
    {#snippet title()}
      <a
        class="title truncate"
        href="https://www.youtube.com/watch?v={item.video.id}"
        target="_blank"
        rel="noopener noreferrer"
        title="Open video on YouTube"
      >
        {item.video.title}
      </a>
    {/snippet}
    {#snippet meta()}
      <div class="meta faint truncate">
        {video?.channelTitle ?? ''}
        {#if video?.commentsDisabled}<span class="badge warn">Comments disabled</span>{/if}
      </div>
    {/snippet}
  </ThreadHeader>

  <div class="scroll" bind:this={scroller}>
    {#if detail}
      {#each detail.comments as c, i (c.id)}
        <CommentCard comment={c} focused={c.id === item.comment.id} reply={i > 0} {now} />
      {/each}
      {#if notFetched > 0}
        <p class="more meta faint">{pluralize(notFetched, 'more reply')} not fetched</p>
      {/if}
    {:else if thread.error}
      <p class="more meta" style="color: var(--danger)">{thread.error}</p>
      <CommentCard comment={item.comment} focused {now} />
    {:else}
      <!-- Instant placeholder from the list item while the thread loads. -->
      {#if item.parent}<p class="more meta faint">
          In reply to {item.parent.authorName}: {item.parent.textPlain.slice(0, 140)}
        </p>{/if}
      <CommentCard comment={item.comment} focused {now} />
      <div class="skeleton" aria-hidden="true"></div>
    {/if}
  </div>

  <Composer {item} canReply={detail?.canReply ?? true} />
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
  .thumb {
    width: 64px;
    height: 36px;
    object-fit: cover;
    border-radius: 4px;
    flex: none;
    background: var(--bg-hover);
  }
  .title {
    display: block;
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .title:hover {
    text-decoration: underline;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: var(--s3) var(--s2);
    position: relative;
  }
  .more {
    padding: var(--s2) var(--s4);
  }
  .skeleton {
    height: 56px;
    margin: var(--s3) var(--s4);
    border-radius: var(--radius);
    background: linear-gradient(90deg, var(--bg-hover), var(--bg-sunken), var(--bg-hover));
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  @media (max-width: 899px) {
    .title {
      white-space: normal;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      padding: 12px 0;
      font-size: 16px;
    }
    .scroll {
      padding: var(--s3) var(--s1);
    }
  }
</style>
