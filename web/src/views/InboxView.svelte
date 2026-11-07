<script lang="ts">
  import { keymap } from '../lib/keys/keymap.svelte';
  import { inboxBindings } from '../lib/keys/bindings';
  import { router } from '../lib/router.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { thread } from '../lib/stores/thread.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import OwnChannelForm from '../components/OwnChannelForm.svelte';
  import { sources } from '../lib/stores/sources.svelte';
  import { sync } from '../lib/stores/sync.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { ago, pluralize } from '../lib/format';
  import InboxRow from '../components/InboxRow.svelte';
  import ThreadView from '../components/ThreadView.svelte';
  import VirtualList from '../components/VirtualList.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import AddSourceForm from '../components/AddSourceForm.svelte';
  import Kbd from '../components/Kbd.svelte';
  import ActionButton from '../components/ActionButton.svelte';
  import Icon from '../components/Icon.svelte';
  import { onMount, untrack } from 'svelte';

  const view = $derived(router.route === 'done' ? 'done' : router.route === 'all' ? 'all' : 'inbox');
  const title = $derived({ inbox: 'Inbox', done: 'Done', all: 'All' }[view]);
  const sourceId = $derived(router.query.source ? Number(router.query.source) : undefined);
  const videoId = $derived(router.query.video || undefined);
  const q = $derived(router.query.q || '');
  const source = $derived(sourceId !== undefined ? sources.get(sourceId) : undefined);

  // URL is the source of truth for view + filters.
  $effect(() => {
    const filters = {
      sourceId: Number.isFinite(sourceId) ? sourceId : undefined,
      videoId,
      q: q || undefined,
    };
    const c = router.query.c;
    untrack(() => void inbox.configure(view, filters, c));
  });

  // Keymap: list scope bindings + scope stack while mounted.
  onMount(() => {
    const unreg = keymap.register(inboxBindings());
    const unList = keymap.pushScope('list');
    return () => {
      unreg();
      unList();
    };
  });
  $effect(() => {
    if (ui.pane !== 'thread') return;
    return keymap.pushScope('thread');
  });

  // Selection drives the thread pane, prefetch, and the deep link.
  const selected = $derived(inbox.selected);
  $effect(() => {
    const s = selected;
    untrack(() => void thread.show(s?.comment.threadId ?? null, s?.comment.id));
    if (s) {
      const i = inbox.selectedIndex;
      thread.prefetch(inbox.items[i + 1]?.comment.threadId);
      thread.prefetch(inbox.items[i - 1]?.comment.threadId);
    }
  });
  let urlTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const id = selected?.comment.id;
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      if ((router.query.c ?? undefined) !== id) router.setQuery({ c: id });
    }, 300);
    return () => clearTimeout(urlTimer);
  });

  // Search box.
  let searchInput: HTMLInputElement | undefined = $state();
  let searchText = $state(router.query.q ?? '');
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    searchText = q;
  });
  $effect(() => {
    if (ui.searchFocusTick > 0) {
      searchInput?.focus();
      searchInput?.select();
    }
  });
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => router.setQuery({ q: searchText.trim() || undefined, c: undefined }), 200);
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (searchText) {
        searchText = '';
        onSearchInput();
      } else searchInput?.blur();
    } else if (e.key === 'Enter') {
      e.stopPropagation();
      clearTimeout(searchTimer);
      router.setQuery({ q: searchText.trim() || undefined, c: undefined });
      searchInput?.blur();
    }
  }

  // Resizable list pane.
  let dragging = $state(false);
  function startDrag(e: PointerEvent) {
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function drag(e: PointerEvent) {
    if (!dragging) return;
    const left = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().left;
    ui.setListWidth(e.clientX - left);
  }

  const filtered = $derived(!!(sourceId || videoId || q));
  const noSources = $derived(sources.loaded && sources.list.length === 0);
  const filterVideoTitle = $derived(
    videoId ? (inbox.items.find((i) => i.video.id === videoId)?.video.title ?? videoId) : null,
  );
</script>

<div class="inbox" class:thread-open={ui.pane === 'thread'}>
  <section class="list" style:width="{ui.listWidth}px" aria-label="{title} list">
    <header>
      <h1>{title}</h1>
      <span class="faint meta count">{pluralize(inbox.total || inbox.items.length, 'comment')}</span>
      <span class="grow"></span>
    </header>
    <div class="filters">
      <label class="search">
        <Icon name="search" size={14} />
        <input
          bind:this={searchInput}
          bind:value={searchText}
          oninput={onSearchInput}
          onkeydown={onSearchKey}
          placeholder="Search comments"
          aria-label="Search comments"
          data-testid="search"
        />
        {#if !searchText}<Kbd label="/" />{/if}
      </label>
      {#if source}<span class="chip"
          >{source.title ?? source.ytId}<button
            aria-label="Clear source filter"
            onclick={() => router.setQuery({ source: undefined, c: undefined }, { replace: false })}>×</button
          ></span
        >{/if}
      {#if filterVideoTitle}<span class="chip"
          ><span class="truncate" style="max-width:160px">{filterVideoTitle}</span><button
            aria-label="Clear video filter"
            onclick={() => router.setQuery({ video: undefined, c: undefined }, { replace: false })}>×</button
          ></span
        >{/if}
    </div>

    {#if inbox.selectedIds.size > 0}
      <div class="bulk" role="toolbar" aria-label="Selected comments" data-testid="bulk-bar">
        <span class="badge accent">{inbox.selectedIds.size} selected</span>
        <ActionButton id="triage.done" label="Done" icon="check" testid="bulk-done" />
        <ActionButton id="triage.replied" label="Replied" icon="check-all" testid="bulk-replied" />
        <span class="grow"></span>
        <ActionButton id="list.escape" label="Clear" icon="x" testid="bulk-clear" />
      </div>
    {/if}

    {#if inbox.pendingCount > 0}
      <button class="pill" onclick={() => void inbox.showPending()} data-testid="new-pill">
        {inbox.pendingCount} new · press <Kbd label="." /> to show
      </button>
    {/if}

    {#if inbox.error}
      <EmptyState title="Couldn't load comments" body={inbox.error}>
        <button class="btn" onclick={() => void inbox.load()}>Retry</button>
      </EmptyState>
    {:else if !inbox.loaded}
      <div class="loading faint meta">Loading…</div>
    {:else if inbox.items.length === 0}
      {#if noSources && !filtered}
        <EmptyState
          title="Add a playlist, video or channel"
          body="Youtubey watches the sources you add and gathers every new comment here."
        >
          {#if settings.needsOwnChannel}
            <div class="own-ask" data-testid="own-channel-prompt">
              <strong>Which channel is yours?</strong>
              <span class="muted meta">Paste your channel URL or @handle. We'll track its videos too.</span>
              <OwnChannelForm />
            </div>
            <p class="muted meta or">Or track something else</p>
          {/if}
          <AddSourceForm autofocus={!settings.needsOwnChannel} compact />
        </EmptyState>
      {:else if filtered}
        <EmptyState title="Nothing matches" body="No comments for the current filters.">
          <button
            class="btn"
            onclick={() =>
              router.setQuery({ source: undefined, video: undefined, q: undefined, c: undefined }, { replace: false })}
            >Clear filters <Kbd label="g" /><Kbd label="c" /></button
          >
        </EmptyState>
      {:else if view === 'inbox'}
        <EmptyState
          title="All caught up"
          body={sync.status.lastRun
            ? `Last synced ${ago(sync.status.lastRun.finishedAt ?? sync.status.lastRun.startedAt, sync.now)}.`
            : 'Nothing needs your attention.'}
        >
          <span class="muted meta">Press <Kbd id="sync.now" /> to sync now</span>
        </EmptyState>
      {:else}
        <EmptyState title="Nothing here yet" body="Triaged comments will show up in this view." />
      {/if}
    {:else}
      <VirtualList
        items={inbox.items}
        rowHeight={84}
        selectedIndex={inbox.selectedIndex}
        onNearEnd={() => void inbox.loadMore()}
        key={(i) => i.comment.id}
      >
        {#snippet row(item, _index)}
          <InboxRow
            {item}
            now={sync.now}
            selected={item.comment.id === inbox.selectedId}
            checked={inbox.selectedIds.has(item.comment.id)}
            onclick={() => {
              inbox.select(item.comment.id);
              ui.pane = 'thread';
            }}
          />
        {/snippet}
      </VirtualList>
    {/if}
  </section>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="resizer"
    role="separator"
    aria-orientation="vertical"
    onpointerdown={startDrag}
    onpointermove={drag}
    onpointerup={() => (dragging = false)}
    class:dragging
  ></div>

  <div class="detail">
    {#if selected}
      {#key selected.comment.threadId}
        <ThreadView item={selected} now={sync.now} />
      {/key}
    {:else}
      <EmptyState
        title={inbox.loaded && inbox.items.length ? 'Select a comment' : ' '}
        body={inbox.items.length ? 'Use j / k to move, Enter to open.' : undefined}
      />
    {/if}
  </div>
</div>

<style>
  .own-ask {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    align-items: stretch;
    text-align: left;
  }
  .or {
    margin: var(--s3) 0 var(--s2);
  }
  .inbox {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .list {
    flex: none;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg-elev);
    position: relative;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    padding: var(--s3) var(--s4) var(--s2);
  }
  h1 {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .grow {
    flex: 1;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  .filters {
    display: flex;
    gap: var(--s2);
    align-items: center;
    flex-wrap: wrap;
    padding: 0 var(--s3) var(--s2);
    border-bottom: 1px solid var(--border);
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex: 1;
    min-width: 140px;
    height: 28px;
    padding: 0 var(--s2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text-faint);
  }
  .search:focus-within {
    border-color: var(--border-strong);
    box-shadow: var(--focus-ring);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    outline: none;
    color: var(--text);
  }
  .chip button {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--text-faint);
    padding: 0;
  }
  .bulk {
    display: flex;
    align-items: center;
    gap: var(--s1);
    padding: var(--s1) var(--s3);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--border);
  }
  .pill {
    position: absolute;
    top: 96px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 4;
    border: 0;
    padding: 5px 14px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: var(--fs-meta);
    font-weight: 500;
    box-shadow: var(--shadow-pop);
    cursor: pointer;
    animation: drop 160ms var(--ease);
  }
  .pill :global(kbd) {
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.3);
    color: #fff;
  }
  @keyframes drop {
    from {
      opacity: 0;
      transform: translate(-50%, -6px);
    }
  }
  .loading {
    padding: var(--s5);
    text-align: center;
  }
  .resizer {
    width: 5px;
    margin: 0 -2px;
    cursor: col-resize;
    z-index: 3;
    flex: none;
    position: relative;
    touch-action: none;
  }
  .resizer::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border);
  }
  .resizer:hover::after,
  .resizer.dragging::after {
    background: var(--accent);
    width: 2px;
  }
  .detail {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  @media (max-width: 899px) {
    .list {
      width: 100% !important;
    }
    .resizer {
      display: none;
    }
    .inbox:not(.thread-open) .detail {
      display: none;
    }
    .inbox.thread-open .list {
      display: none;
    }
  }
</style>
