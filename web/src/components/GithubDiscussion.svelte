<script lang="ts">
  import type { GithubDiscussionDTO, GithubDiscussionEntry } from '../../../shared/types';
  import { ApiRequestError, api } from '../lib/api';
  import { entryChip, inlineContext, isNewEntry, reviewBadge } from '../lib/github';
  import { relativeTime } from '../lib/format';
  import { renderMarkdown } from '../lib/sanitize';
  import Avatar from './Avatar.svelte';

  let {
    itemId,
    comments,
    since,
    url,
    now,
  }: {
    itemId: string;
    /** The synced comment count: when it changes the conversation is fetched again. */
    comments: number;
    /** Entries after this are marked "new". */
    since: string | null;
    url: string | null;
    now: number;
  } = $props();

  let fetched = $state<{ id: string; dto: GithubDiscussionDTO } | null>(null);
  let failed = $state<string | null>(null);
  let loading = $state(false);

  $effect(() => {
    const id = itemId;
    void comments;
    let live = true;
    loading = true;
    failed = null;
    api
      .githubDiscussion(id)
      .then((d) => {
        if (live) fetched = { id, dto: d };
      })
      .catch((e: unknown) => {
        if (live) failed = e instanceof ApiRequestError ? e.message : 'Network error';
      })
      .finally(() => {
        if (live) loading = false;
      });
    return () => {
      live = false;
    };
  });

  // The previous conversation stays while a refresh runs (a sync bumping the count), but never another item's.
  const data = $derived(fetched?.id === itemId ? fetched.dto : null);
  const entries = $derived(data?.entries ?? []);
  const newCount = $derived(entries.filter((e) => isNewEntry(e, since)).length);
  const ctx = (e: GithubDiscussionEntry) => inlineContext(e);
</script>

<section class="disc" data-testid="gh-discussion" aria-label="Conversation" aria-busy={loading}>
  <h3>
    Conversation
    {#if newCount > 0}<span class="badge accent" data-testid="gh-new-count">{newCount} new</span>{/if}
  </h3>

  {#if failed}
    <p class="note faint" role="status" data-testid="gh-discussion-error">
      Couldn't load the conversation ({failed}).
      {#if url}<a href={url} target="_blank" rel="noopener noreferrer">Read it on GitHub</a>.{/if}
    </p>
  {/if}

  {#if loading && !data}
    <p class="note faint" data-testid="gh-discussion-loading">Loading the conversation…</p>
  {:else if data && entries.length === 0 && !failed}
    <p class="note faint" data-testid="gh-discussion-empty">No comments yet.</p>
  {/if}

  {#if data?.olderCut}
    <p class="note faint" data-testid="gh-older-cut">
      Older entries are not shown.
      {#if url}<a href={url} target="_blank" rel="noopener noreferrer">See the whole conversation on GitHub</a>.{/if}
    </p>
  {/if}

  <ol>
    {#each entries as e (e.id)}
      {@const chip = entryChip(e)}
      {@const review = reviewBadge(e)}
      {@const isNew = isNewEntry(e, since)}
      <li
        class="entry"
        class:bot={e.authorType === 'Bot'}
        class:new={isNew}
        class:reply={!!e.replyTo}
        data-testid="gh-entry"
        data-kind={e.kind}
      >
        <div class="by">
          <Avatar url={e.avatarUrl} name={e.author} size={20} />
          <strong>{e.author}</strong>
          {#if chip}<span class="badge chip {chip.tone}" title={chip.title}>{chip.text}</span>{/if}
          {#if review}<span class="badge {review.tone}" data-testid="gh-review-state" title={review.title}
              >{review.text}</span
            >{/if}
          {#if isNew}<span class="badge accent" data-testid="gh-new">New</span>{/if}
          <span class="faint meta when">
            {#if e.url}<a href={e.url} target="_blank" rel="noopener noreferrer" title={e.createdAt}
                >{relativeTime(e.createdAt, now)}</a
              >{:else}{relativeTime(e.createdAt, now)}{/if}
          </span>
        </div>
        {#if ctx(e)}<div class="file mono" data-testid="gh-inline-context">{ctx(e)}</div>{/if}
        {#if e.body}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by renderMarkdown -->
          <div class="md">{@html renderMarkdown(e.body)}</div>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .disc {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    min-width: 0;
  }
  h3 {
    margin: 0;
    font-size: 1em;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: var(--s2);
  }
  .note {
    margin: 0;
  }
  .note a,
  .when a {
    color: inherit;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  .entry {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elev);
    padding: var(--s3) var(--s4);
    min-width: 0;
  }
  .entry.new {
    border-color: var(--accent);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .entry.reply {
    margin-left: var(--s4);
  }
  .entry.bot {
    background: transparent;
    font-size: var(--fs-meta);
    color: var(--text-muted);
    padding: var(--s2) var(--s3);
  }
  .by {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s2);
    margin-bottom: var(--s2);
  }
  .when {
    margin-left: auto;
  }
  .file {
    font-size: var(--fs-label);
    color: var(--text-muted);
    background: var(--bg-sunken);
    border-radius: 4px;
    padding: 2px 6px;
    margin-bottom: var(--s2);
    overflow-wrap: anywhere;
  }
  .chip.accent {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .chip.muted,
  .badge.muted {
    opacity: 0.75;
  }
  .md {
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .md :global(> :first-child) {
    margin-top: 0;
  }
  .md :global(> :last-child) {
    margin-bottom: 0;
  }
  .md :global(p),
  .md :global(ul),
  .md :global(ol),
  .md :global(blockquote),
  .md :global(pre),
  .md :global(table),
  .md :global(details) {
    margin: 0 0 var(--s3);
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.4em;
  }
  .md :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--bg-hover);
    border-radius: 4px;
    padding: 0 4px;
  }
  .md :global(pre) {
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--s2) var(--s3);
    overflow-x: auto;
  }
  .md :global(pre code) {
    background: none;
    padding: 0;
  }
  .md :global(blockquote) {
    border-left: 3px solid var(--border-strong);
    padding-left: var(--s3);
    color: var(--text-muted);
  }
  .md :global(a) {
    color: var(--accent);
  }
  .md :global(img) {
    max-width: 100%;
  }
  @media (max-width: 899px) {
    .entry {
      padding: var(--s3);
    }
    .entry.reply {
      margin-left: var(--s2);
    }
  }
</style>
