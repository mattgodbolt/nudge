<script lang="ts">
  import type { CommentDTO } from '../../../shared/types';
  import { sanitizeCommentHtml } from '../lib/sanitize';
  import { fullDate, relativeTime, compactNumber } from '../lib/format';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';

  let {
    comment,
    focused = false,
    reply = false,
    now,
  }: { comment: CommentDTO; focused?: boolean; reply?: boolean; now: number } = $props();
  const html = $derived(sanitizeCommentHtml(comment.textHtml));
</script>

<article
  class="card"
  class:focused
  class:reply
  class:own={comment.isOwn}
  data-comment-id={comment.id}
  data-focused={focused}
>
  <Avatar url={comment.authorAvatarUrl} name={comment.authorName} size={reply ? 24 : 32} />
  <div class="main">
    <header>
      <span class="author">{comment.authorName}</span>
      {#if comment.isOwn}<span class="badge accent">You</span>{/if}
      <time class="faint meta" datetime={comment.publishedAt} title={fullDate(comment.publishedAt)}
        >{relativeTime(comment.publishedAt, now)}</time
      >
      {#if comment.updatedAt !== comment.publishedAt && Date.parse(comment.updatedAt) - Date.parse(comment.publishedAt) > 60_000}
        <span class="faint meta">(edited)</span>
      {/if}
      <span class="spacer"></span>
      {#if comment.likeCount > 0}<span class="faint meta likes">♥ {compactNumber(comment.likeCount)}</span>{/if}
      <a
        class="btn ghost sm ext"
        href={comment.permalink}
        target="_blank"
        rel="noopener noreferrer"
        title="Open on YouTube (v)"
        aria-label="Open on YouTube"
      >
        <Icon name="external" size={13} />
      </a>
    </header>
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by DOMPurify -->
    <div class="comment-html">{@html html}</div>
  </div>
</article>

<style>
  .card {
    display: flex;
    gap: var(--s3);
    padding: var(--s3) var(--s4);
    border-radius: var(--radius-lg);
    border: 1px solid transparent;
  }
  .card.reply {
    margin-left: var(--s6);
    padding: var(--s2) var(--s3);
    border-left: 2px solid var(--border);
    border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
  }
  .card.own {
    background: var(--own-bg);
  }
  .card.focused {
    background: var(--bg-selected);
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .card.focused.reply {
    border-left-color: var(--accent);
  }
  .main {
    min-width: 0;
    flex: 1;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: 2px;
  }
  .author {
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .ext {
    opacity: 0;
    padding: 0 6px;
  }
  .card:hover .ext,
  .ext:focus-visible {
    opacity: 1;
  }
  .comment-html {
    line-height: 1.55;
  }
</style>
