<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { usage } from '../lib/usage';
  import { stateLabel } from '../lib/itemState';
  import { decisions } from '../lib/decisions';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { thread } from '../lib/stores/thread.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { pluralize } from '../lib/format';
  import { phone } from '../lib/phone.svelte';
  import { formatSnoozeTime, recentlyWoken } from '../lib/snooze';
  import CommentCard from './CommentCard.svelte';
  import Composer from './Composer.svelte';
  import ItemActions from './ItemActions.svelte';
  import Icon from './Icon.svelte';
  import SuggestionChip from './SuggestionChip.svelte';
  import { tick, untrack } from 'svelte';

  let { item, now }: { item: InboxItem; now: number } = $props();
  /** "Done", "Dismissed" ... once the item is dealt with; empty while it is in the inbox. */
  const stateText = $derived(stateLabel(item.comment));
  // Each thread is mounted once per open (the parent keys on it), so this counts opens, not renders.
  usage.count('view.thread');
  // Opened now, closed when this thread unmounts or another item takes its place; dwell is measured in between.
  $effect(() =>
    decisions.open(
      item.comment.id,
      untrack(() => inbox.viewName),
    ),
  );

  let headerWidth = $state(1000);
  // Actions share the title row only in a roomy pane; otherwise they take a row of their own,
  // and drop their labels (still tooltipped) when even that row is too narrow.
  const inline = $derived(headerWidth >= 1500);
  let scroller: HTMLDivElement | undefined = $state();
  const detail = $derived(thread.current && thread.current.threadId === item.comment.threadId ? thread.current : null);
  const notFetched = $derived(detail ? Math.max(0, detail.totalReplyCount - (detail.comments.length - 1)) : 0);
  const video = $derived(detail?.video ?? null);
  const woke = $derived(!item.snoozedUntil && item.comment.state === 'inbox' && recentlyWoken(item.wokeAt, now));

  // Bring the focused comment into view whenever the thread or focus changes.
  $effect(() => {
    void detail;
    const cid = item.comment.id;
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
  <header bind:clientWidth={headerWidth}>
    <button class="btn ghost sm back" onclick={() => (ui.pane = 'list')} aria-label="Back to list"
      ><Icon name="chevron-left" size={phone.value ? 22 : 15} /> Back</button
    >
    {#if item.video.thumbnailUrl}
      <img class="thumb" src={item.video.thumbnailUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
    {/if}
    <div class="vt">
      <a
        class="title truncate"
        href="https://www.youtube.com/watch?v={item.video.id}"
        target="_blank"
        rel="noopener noreferrer"
        title="Open video on YouTube"
      >
        {item.video.title}
      </a>
      <div class="meta faint truncate">
        {video?.channelTitle ?? ''}
        {#if video?.commentsDisabled}<span class="badge warn">Comments disabled</span>{/if}
      </div>
      {#if item.snoozeWhy && item.comment.state === 'inbox'}
        <div class="why faint" data-testid="thread-why">You snoozed this to: {item.snoozeWhy}</div>
      {/if}
      {#if item.snoozedUntil || woke || stateText}
        <div class="tags">
          {#if stateText}<span class="badge" data-testid="thread-state">{stateText}</span>{/if}
          {#if item.snoozedUntil}
            <span class="snz" data-testid="thread-snoozed"
              >⏰ Snoozed until {formatSnoozeTime(item.snoozedUntil, new Date(now))}</span
            >
          {:else if woke}
            <span class="snz" data-testid="thread-woke">⏰ back from snooze</span>
          {/if}
        </div>
      {/if}
    </div>
    <ItemActions {item} width={headerWidth} ownRow={!inline} label="Comment actions" />
    {#if ui.showSuggestions && item.suggestion}<SuggestionChip
        suggestion={item.suggestion}
        testid="thread-suggestion"
        full
      />{/if}
  </header>

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
  .thumb {
    width: 64px;
    height: 36px;
    object-fit: cover;
    border-radius: 4px;
    flex: none;
    background: var(--bg-hover);
  }
  .vt {
    min-width: 0;
    flex: 1;
  }
  /* What he said he would do on return: quiet, but never cut off. */
  .why {
    font-size: var(--fs-meta);
    font-style: italic;
    overflow-wrap: anywhere;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2);
    margin-top: 3px;
  }
  .snz {
    font-size: var(--fs-label);
    color: var(--secondary);
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
  .back {
    display: none;
  }
  @media (max-width: 899px) {
    header {
      padding: var(--s2) var(--s3) var(--s3);
      gap: var(--s2) var(--s3);
    }
    .back {
      display: inline-flex;
      flex-basis: calc(100% + var(--s5));
      height: 52px;
      justify-content: flex-start;
      gap: var(--s2);
      margin: calc(var(--s2) * -1) calc(var(--s3) * -1) 0;
      width: calc(100% + var(--s5));
      border-radius: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
      border-bottom: 1px solid var(--border);
    }
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
