<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { thread } from '../lib/stores/thread.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { pluralize } from '../lib/format';
  import CommentCard from './CommentCard.svelte';
  import Composer from './Composer.svelte';
  import ActionButton from './ActionButton.svelte';
  import Icon from './Icon.svelte';
  import { tick, untrack } from 'svelte';

  let { item, now }: { item: InboxItem; now: number } = $props();

  let headerWidth = $state(1000);
  // Actions share the title row only in a roomy pane; otherwise they take a row of their own,
  // and drop their labels (still tooltipped) when even that row is too narrow.
  const inline = $derived(headerWidth >= 1000);
  const wide = $derived(headerWidth >= 500);
  let scroller: HTMLDivElement | undefined = $state();
  const detail = $derived(thread.current && thread.current.threadId === item.comment.threadId ? thread.current : null);
  const notFetched = $derived(detail ? Math.max(0, detail.totalReplyCount - (detail.comments.length - 1)) : 0);
  const video = $derived(detail?.video ?? null);

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
      ><Icon name="chevron-left" size={15} /> Back</button
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
    </div>
    <div
      class="actions"
      class:own-row={!inline}
      role="toolbar"
      aria-label="Comment actions"
      data-testid="thread-actions"
    >
      <ActionButton id="reply.open" label="Reply" icon="reply" showLabel={wide} testid="act-reply" />
      <ActionButton id="triage.done" label="Done" icon="check" showLabel={wide} testid="act-done" />
      <ActionButton id="triage.replied" label="Mark replied" icon="check-all" showLabel={wide} testid="act-replied" />
      {#if item.comment.state !== 'inbox'}
        <ActionButton id="triage.inbox" label="Move back to inbox" icon="inbox" showLabel={wide} testid="act-inbox" />
      {/if}
      <ActionButton
        id="triage.undo"
        label="Undo"
        icon="undo"
        showLabel={wide}
        disabled={inbox.undoDepth === 0}
        testid="act-undo"
      />
      <ActionButton id="open.comment" label="Open on YouTube" icon="external" showLabel={wide} testid="act-open" />
    </div>
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
  .actions {
    display: flex;
    flex: none;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) + 2px);
    background: var(--bg);
  }
  .actions.own-row {
    flex-basis: 100%;
    justify-content: flex-start;
    border: 0;
    padding: 0;
    background: none;
    margin-top: calc(var(--s1) * -1);
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
    .back {
      display: inline-flex;
    }
  }
</style>
