<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { authorChip, reasonChip, refLabel, statusChip } from '../lib/github';
  import { relativeTime } from '../lib/format';
  import { phone } from '../lib/phone.svelte';
  import { formatSnoozeTime, recentlyWoken } from '../lib/snooze';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import ActionButton from './ActionButton.svelte';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  import LabelChips from './LabelChips.svelte';

  let { item, now }: { item: InboxItem; now: number } = $props();

  const it = $derived(item.item);
  const g = $derived(it.github);
  const chips = $derived([reasonChip(it), authorChip(it), statusChip(it)].filter((c) => c !== null));
  const tile = $derived(phone.value);
  const woke = $derived(!item.snoozedUntil && item.comment.state === 'inbox' && recentlyWoken(item.wokeAt, now));
</script>

<section class="thread" data-testid="thread-view" class:focus={ui.pane === 'thread'} aria-label="Pull request or issue">
  <header>
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
      {#if item.snoozedUntil || item.labels.length > 0 || woke || chips.length > 0}
        <div class="tags">
          {#each chips as chip (chip.text)}
            <span class="badge chip {chip.tone}" title={chip.title}>{chip.text}</span>
          {/each}
          {#if item.snoozedUntil}
            <span class="snz" data-testid="thread-snoozed"
              >⏰ Snoozed until {formatSnoozeTime(item.snoozedUntil, new Date(now))}</span
            >
          {:else if woke}
            <span class="snz" data-testid="thread-woke">⏰ back from snooze</span>
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
      <ActionButton id="mute.open" label="Mute" icon="x" showLabel={!tile} {tile} testid="act-mute" />
      <ActionButton
        id="triage.undo"
        label="Undo"
        icon="undo"
        showLabel={!tile}
        {tile}
        disabled={inbox.undoDepth === 0}
        testid="act-undo"
      />
      <ActionButton
        id="open.comment"
        label="Open on GitHub"
        short="Open"
        icon="external"
        showLabel={!tile}
        {tile}
        testid="act-open"
      />
    </div>
  </header>

  <div class="scroll">
    <article class="card" data-testid="gh-body">
      <div class="by">
        <Avatar url={it.authorAvatarUrl} name={it.author ?? '?'} />
        <strong>{it.author}</strong>
        <span class="faint meta">opened {relativeTime(item.comment.publishedAt, now)}</span>
      </div>
      {#if item.comment.textPlain}
        <p class="text">{item.comment.textPlain}</p>
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
    <p class="faint meta hint">
      Replies, reviews and the full conversation live on GitHub: press <kbd class="mono">v</kbd> to open it.
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
  .chip.accent {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .chip.muted {
    opacity: 0.75;
  }
  @media (max-width: 899px) {
    .actions {
      width: 100%;
    }
  }
</style>
