<script lang="ts">
  import { untrack } from 'svelte';
  import type { InboxItem } from '../../../shared/types';
  import { usage } from '../lib/usage';
  import { stateLabel } from '../lib/itemState';
  import { decisions } from '../lib/decisions';
  import { authorChip, reasonChip, refLabel, statusChip } from '../lib/github';
  import { relativeTime } from '../lib/format';
  import { renderMarkdown } from '../lib/sanitize';
  import { phone } from '../lib/phone.svelte';
  import { formatSnoozeTime, recentlyWoken } from '../lib/snooze';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import ItemActions from './ItemActions.svelte';
  import NudgeDraft from './NudgeDraft.svelte';
  import SnoozeNote from './SnoozeNote.svelte';
  import Avatar from './Avatar.svelte';
  import GithubDiscussion from './GithubDiscussion.svelte';
  import Icon from './Icon.svelte';
  import SuggestionChip from './SuggestionChip.svelte';

  let { item, now }: { item: InboxItem; now: number } = $props();
  /** "Done", "Dismissed" ... once the item is dealt with; empty while it is in the inbox. */
  const stateText = $derived(stateLabel(item.comment));
  // Each thread is mounted once per open (the parent keys on it), so this counts opens, not renders.
  usage.count('view.github_thread');
  // Opened now, closed when this thread unmounts or another item takes its place; dwell is measured in between.
  $effect(() =>
    decisions.open(
      item.comment.id,
      untrack(() => inbox.viewName),
    ),
  );

  const it = $derived(item.item);
  const g = $derived(it.github);
  const chips = $derived([reasonChip(it), authorChip(it), statusChip(it)].filter((c) => c !== null));
  // The title block always gets the width it needs: the toolbar shares its row only in a very roomy pane, and otherwise
  // takes a row of its own (it used to squeeze the title into a narrow column that wrapped to a dozen lines).
  let headerWidth = $state(1000);
  const inline = $derived(headerWidth >= 1700);
  const woke = $derived(!item.snoozedUntil && item.comment.state === 'inbox' && recentlyWoken(item.wokeAt, now));
</script>

<section class="thread" data-testid="thread-view" class:focus={ui.pane === 'thread'} aria-label="Pull request or issue">
  <header bind:clientWidth={headerWidth}>
    <button class="btn ghost sm back" onclick={() => (ui.pane = 'list')} aria-label="Back to list"
      ><Icon name="chevron-left" size={phone.value ? 22 : 15} /> Back</button
    >
    <div class="vt">
      <a class="title" href={it.url ?? '#'} target="_blank" rel="noopener noreferrer" title="Open on GitHub"
        >{it.title}</a
      >
      <div class="meta faint">
        <a href={it.containerUrl ?? '#'} target="_blank" rel="noopener noreferrer">{refLabel(it)}</a>
        · {it.kind === 'pr' ? 'Pull request' : 'Issue'}
      </div>
      <SnoozeNote {item} />
      {#if item.snoozedUntil || woke || chips.length > 0 || stateText}
        <div class="tags">
          {#if stateText}<span class="badge" data-testid="thread-state">{stateText}</span>{/if}
          {#each chips as chip (chip.text)}
            <span class="badge rowchip {chip.tone}" title={chip.title}>{chip.text}</span>
          {/each}
          {#if item.snoozedUntil}
            <span class="snz" data-testid="thread-snoozed"
              >⏰ Snoozed until {item.snoozeUntilActivity ? 'activity, or ' : ''}{formatSnoozeTime(
                item.snoozedUntil,
                new Date(now),
              )}</span
            >
          {:else if woke}
            <span class="snz" data-testid="thread-woke">⏰ back from snooze</span>
          {/if}
        </div>
      {/if}
    </div>
    <ItemActions {item} width={headerWidth} ownRow={!inline} label="Item actions" />
    {#if ui.showSuggestions && item.suggestion}<SuggestionChip
        suggestion={item.suggestion}
        testid="thread-suggestion"
        full
      />{/if}
  </header>

  <div class="scroll">
    <NudgeDraft {item} />
    <article class="card" data-testid="gh-body">
      <div class="by">
        <Avatar url={it.authorAvatarUrl} name={it.author ?? '?'} />
        <strong>{it.author}</strong>
        <span class="faint meta">opened {relativeTime(item.comment.publishedAt, now)}</span>
      </div>
      {#if item.comment.textPlain}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by renderMarkdown -->
        <div class="md" data-testid="gh-markdown">{@html renderMarkdown(item.comment.textPlain)}</div>
      {:else}
        <p class="faint">No description.</p>
      {/if}
    </article>
    <dl class="facts meta">
      <dt>State</dt>
      <dd>{it.sourceState ?? 'open'}{g?.draft ? ' (draft)' : ''}</dd>
      <dt>Comments</dt>
      <dd>{g?.comments ?? 0}</dd>
      {#if g && g.labels.length > 0}
        <dt>GitHub labels</dt>
        <dd>{g.labels.join(', ')}</dd>
      {/if}
    </dl>
    <GithubDiscussion
      itemId={it.id}
      comments={g?.comments ?? 0}
      since={it.reason === 'new_activity' ? (g?.activitySince ?? null) : null}
      url={it.url}
      {now}
    />
    <p class="faint meta hint">Replying happens on GitHub: press <kbd class="mono">v</kbd> to open it.</p>
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
  .meta a {
    color: inherit;
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
  .by {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s3);
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px var(--s4);
    margin: 0;
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
  }
  .hint {
    margin: 0;
  }
  .rowchip.accent {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .rowchip.muted {
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
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: var(--s4) 0 var(--s2);
    font-size: 1em;
    font-weight: 600;
  }
  .md :global(h1),
  .md :global(h2) {
    font-size: 1.1em;
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
  .md :global(summary) {
    cursor: pointer;
    color: var(--text-muted);
  }
  .md :global(a) {
    color: var(--accent);
  }
  .md :global(table) {
    border-collapse: collapse;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--border);
    padding: 2px 8px;
  }
  .md :global(hr) {
    border: 0;
    border-top: 1px solid var(--border);
    margin: var(--s3) 0;
  }
</style>
