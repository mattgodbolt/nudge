<script lang="ts">
  import type { InboxOrder } from '../../../shared/types';
  import { resync } from '../lib/resync.svelte';
  import { phone } from '../lib/phone.svelte';
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
  import { ago, formatNumber, pluralize } from '../lib/format';
  import { suggestStatus } from '../lib/stores/suggestStatus.svelte';
  import { isSuggestionFilter, SUGGESTION_FILTER_OPTIONS } from '../lib/suggestions';
  import InboxRow from '../components/InboxRow.svelte';
  import ThreadView from '../components/ThreadView.svelte';
  import GithubThread from '../components/GithubThread.svelte';
  import TodoThread from '../components/TodoThread.svelte';
  import { feeds } from '../lib/stores/feeds.svelte';
  import VirtualList from '../components/VirtualList.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import AddSourceForm from '../components/AddSourceForm.svelte';
  import Kbd from '../components/Kbd.svelte';
  import ActionButton from '../components/ActionButton.svelte';
  import Icon from '../components/Icon.svelte';
  import { usage } from '../lib/usage';
  import { onMount, tick, untrack } from 'svelte';
  import type { InboxView } from '../../../shared/types';

  const view = $derived<InboxView>(
    router.route === 'done'
      ? 'done'
      : router.route === 'all'
        ? 'all'
        : router.route === 'snoozed'
          ? 'snoozed'
          : 'inbox',
  );
  const title = $derived({ inbox: 'Inbox', done: 'Done', all: 'All', snoozed: 'Snoozed' }[view]);
  const sourceId = $derived(router.query.source ? Number(router.query.source) : undefined);
  const videoId = $derived(router.query.video || undefined);
  const q = $derived(router.query.q || '');
  const feedId = $derived(router.query.feed ? Number(router.query.feed) : undefined);
  const feed = $derived(feedId !== undefined ? feeds.get(feedId) : undefined);
  const repo = $derived(router.query.repo || undefined);
  const kind = $derived<'pr' | 'issue' | 'todo' | undefined>(
    router.query.kind === 'pr' || router.query.kind === 'issue' || router.query.kind === 'todo'
      ? router.query.kind
      : undefined,
  );
  const AUDIENCES = ['outside', 'team', 'contributors', 'bots'] as const;
  const audience = $derived(AUDIENCES.find((a) => a === router.query.who));
  const suggestion = $derived(isSuggestionFilter(router.query.sug) ? router.query.sug : undefined);
  const source = $derived(sourceId !== undefined ? sources.get(sourceId) : undefined);
  // The filter is offered once suggestions exist (a key is set), and stays while one is applied so it can be cleared.
  const showSuggestionFilter = $derived(!!suggestStatus.value?.enabled || suggestion !== undefined);

  // URL is the source of truth for view + filters.
  $effect(() => {
    const filters = {
      sourceId: Number.isFinite(sourceId) ? sourceId : undefined,
      videoId,
      feedId: Number.isFinite(feedId) ? feedId : undefined,
      repo,
      kind,
      audience,
      suggestion,
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
    // Only YouTube comments have a thread to fetch; GitHub items render from the list row alone.
    const yt = (i: { item: { provider: string }; comment: { threadId: string } } | undefined) =>
      i?.item.provider === 'youtube' ? i.comment.threadId : undefined;
    untrack(() => void thread.show(s && yt(s) ? s.comment.threadId : null, s?.comment.id));
    if (s) {
      const i = inbox.selectedIndex;
      thread.prefetch(yt(inbox.items[i + 1]));
      thread.prefetch(yt(inbox.items[i - 1]));
    }
  });
  // On a phone the thread pane replaces the list (and hides the nav). With nothing left to show it would be a blank
  // screen with no way out, so fall back to the list, which carries the empty state.
  $effect(() => {
    if (inbox.loaded && inbox.items.length === 0 && ui.pane === 'thread') ui.pane = 'list';
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
  // Phone only: the search box hides behind a magnifier in the header until asked for (or while it has text).
  let searchOpen = $state(false);
  const searchShown = $derived(searchOpen || !!searchText);
  $effect(() => {
    if (ui.searchFocusTick > 0) {
      searchOpen = true;
      void tick().then(() => {
        searchInput?.focus();
        searchInput?.select();
      });
    }
  });
  function toggleSearch() {
    searchOpen = !searchOpen;
    if (searchOpen) void tick().then(() => searchInput?.focus());
    else if (searchText) {
      searchText = '';
      onSearchInput();
    }
  }
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

  const tile = $derived(phone.value);
  const filtered = $derived(!!(sourceId || videoId || q || suggestion));
  const noSources = $derived(sources.loaded && sources.list.length === 0 && feeds.loaded && feeds.list.length === 0);
  const filterVideoTitle = $derived(
    videoId ? (inbox.items.find((i) => i.video.id === videoId)?.video.title ?? videoId) : null,
  );
</script>

<div class="inbox" class:thread-open={ui.pane === 'thread'}>
  <section class="list" style:width="{ui.listWidth}px" aria-label="{title} list">
    <header>
      <h1>{title}</h1>
      <span class="faint meta count"
        >{pluralize(inbox.total || inbox.items.length, feeds.list.length > 0 ? 'item' : 'comment')}</span
      >
      <span class="grow"></span>
      <label class="sort faint meta">
        <span class="sr">Sort</span>
        <select
          value={inbox.order}
          data-testid="sort"
          aria-label="Sort order"
          title="Sort order (Shift+O cycles)"
          onchange={(e) => void inbox.setOrder(e.currentTarget.value as InboxOrder)}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="arrived">Recently arrived</option>
          <option value="source">By source</option>
        </select>
      </label>
      <button
        class="btn ghost searchbtn"
        class:on={searchShown}
        onclick={toggleSearch}
        aria-label="Search"
        aria-expanded={searchShown}
        data-testid="search-toggle"
      >
        <Icon name="search" size={22} />
      </button>
    </header>
    <div class="filters" class:bare={!feed && !source && !filterVideoTitle} class:searching={searchShown}>
      <label class="search">
        <Icon name="search" size={14} />
        <input
          bind:this={searchInput}
          bind:value={searchText}
          oninput={onSearchInput}
          onkeydown={onSearchKey}
          placeholder={feeds.list.length > 0 ? 'Search' : 'Search comments'}
          aria-label="Search"
          data-testid="search"
        />
        {#if !searchText}<Kbd label="/" />{/if}
      </label>
      {#if feed}<span class="chip" data-testid="feed-chip"
          >{feed.owner}<button
            aria-label="Clear feed filter"
            onclick={() => router.setQuery({ feed: undefined, c: undefined }, { replace: false })}>×</button
          ></span
        >{/if}
      {#if kind === 'todo'}<span class="chip" data-testid="todo-chip"
          >Todos<button
            aria-label="Clear todo filter"
            onclick={() => router.setQuery({ kind: undefined, c: undefined }, { replace: false })}>×</button
          ></span
        >{/if}
      {#if repo}<span class="chip" data-testid="repo-chip"
          >{repo}<button
            aria-label="Clear repository filter"
            onclick={() => router.setQuery({ repo: undefined, c: undefined }, { replace: false })}>×</button
          ></span
        >{/if}
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

    {#if (feeds.list.length > 0 && kind !== 'todo') || showSuggestionFilter}
      <div class="ghfilters" role="group" aria-label="Filter items" data-testid="gh-filters">
        {#if showSuggestionFilter}
          <label class="sugfilter" class:on={suggestion !== undefined}>
            <span class="sr">Filter by suggestion</span>
            <select
              value={suggestion ?? ''}
              data-testid="sug-filter"
              aria-label="Filter by suggestion"
              onchange={(e) =>
                router.setQuery({ sug: e.currentTarget.value || undefined, c: undefined }, { replace: false })}
            >
              {#each SUGGESTION_FILTER_OPTIONS as o (o.value)}
                <option value={o.value}>{o.value === '' ? 'Suggestion: any' : o.label}</option>
              {/each}
            </select>
          </label>
          {#if feeds.list.length > 0 && kind !== 'todo'}<span class="sep"></span>{/if}
        {/if}
        {#if feeds.list.length > 0 && kind !== 'todo'}
          {#each [['', 'All'], ['outside', 'Outside'], ['team', 'Team'], ['contributors', 'Contributors'], ['bots', 'Bots']] as [value, text] (value)}
            <button
              class="seg"
              class:on={(audience ?? '') === value}
              aria-pressed={(audience ?? '') === value}
              data-testid="who-{value || 'all'}"
              onclick={() => router.setQuery({ who: value || undefined, c: undefined }, { replace: false })}
              >{text}</button
            >
          {/each}
          <span class="sep"></span>
          {#each [['', 'Any'], ['pr', 'PRs'], ['issue', 'Issues']] as [value, text] (value)}
            <button
              class="seg"
              class:on={(kind ?? '') === value}
              aria-pressed={(kind ?? '') === value}
              data-testid="kind-{value || 'any'}"
              onclick={() => router.setQuery({ kind: value || undefined, c: undefined }, { replace: false })}
              >{text}</button
            >
          {/each}
        {/if}
      </div>
    {/if}

    {#if inbox.selectedCount > 0}
      <div
        class="bulk"
        role="toolbar"
        aria-label="Selected items: actions apply to these {inbox.selectedCount} only"
        data-testid="bulk-bar"
      >
        <span class="badge accent" data-testid="bulk-count"
          >{inbox.selectedCount === inbox.total || inbox.total === 0
            ? `${formatNumber(inbox.selectedCount)} selected`
            : `${formatNumber(inbox.selectedCount)} selected of ${formatNumber(inbox.total)}`}</span
        >
        {#if inbox.nextCursor && inbox.selectedCount === inbox.items.length}
          <button class="btn sm" data-testid="bulk-all-matching" onclick={() => void inbox.selectAllMatching()}
            >Select all {formatNumber(inbox.total)}</button
          >
        {/if}
        <ActionButton id="sel.all" label="All" icon="check-all" {tile} testid="bulk-all" />
        <ActionButton id="triage.done" label="Done" icon="check" {tile} testid="bulk-done" />
        <ActionButton
          id="triage.dismiss"
          label="No action needed"
          short="No action"
          icon="dismiss"
          {tile}
          testid="bulk-dismiss"
        />
        <ActionButton id="triage.replied" label="Replied" icon="check-all" {tile} testid="bulk-replied" />
        {#if view === 'snoozed'}
          <ActionButton id="triage.inbox" label="Unsnooze" icon="inbox" {tile} testid="bulk-unsnooze" />
        {:else}
          <ActionButton id="snooze.open" label="Snooze" icon="clock" {tile} testid="bulk-snooze" />
        {/if}
        <span class="grow"></span>
        <ActionButton id="list.escape" label="Clear" icon="x" {tile} testid="bulk-clear" />
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
          body="Nudge watches the sources you add and gathers every new comment here."
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
              router.setQuery(
                { source: undefined, video: undefined, q: undefined, sug: undefined, c: undefined },
                { replace: false },
              )}>Clear filters <Kbd label="g" /><Kbd label="c" /></button
          >
        </EmptyState>
      {:else if view === 'snoozed'}
        <EmptyState
          title="Nothing snoozed"
          body="Press b on a comment to hide it until later. It comes back to the top of your inbox."
        />
      {:else if view === 'inbox'}
        <EmptyState
          title="All caught up"
          body={sync.status.lastRun
            ? `Last synced ${ago(sync.status.lastRun.finishedAt ?? sync.status.lastRun.startedAt, sync.now)}.`
            : 'Nothing needs your attention.'}
        >
          <ActionButton id="sync.now" label="Sync now" icon="refresh" testid="empty-sync" />
        </EmptyState>
      {:else}
        <EmptyState title="Nothing here yet" body="Triaged comments will show up in this view." />
      {/if}
    {:else}
      <VirtualList
        items={inbox.items}
        rowHeight={phone.value ? 176 : 102}
        selectedIndex={inbox.selectedIndex}
        onNearEnd={() => void inbox.loadMore()}
        onRefresh={() => {
          usage.action('sync', 'touch');
          return resync.run();
        }}
        key={(i) => i.comment.id}
      >
        {#snippet row(item, _index)}
          <InboxRow
            {item}
            now={sync.now}
            selected={item.comment.id === inbox.selectedId}
            checked={inbox.selectedIds.has(item.comment.id)}
            selecting={inbox.selectedCount > 0}
            ontoggle={() => inbox.toggleSelect(item.comment.id)}
            showState={view === 'all'}
            snoozedView={view === 'snoozed'}
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
        {#if selected.item.provider === 'github'}
          <GithubThread item={selected} now={sync.now} />
        {:else if selected.item.provider === 'todo'}
          <TodoThread item={selected} now={sync.now} />
        {:else}
          <ThreadView item={selected} now={sync.now} />
        {/if}
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
  .searchbtn {
    display: none;
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
    flex-wrap: wrap;
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
    header {
      align-items: center;
      padding: 0 var(--s2) 0 var(--s4);
    }
    h1 {
      font-size: 18px;
    }
    .searchbtn {
      display: inline-flex;
      justify-content: center;
      flex: none;
      width: 44px;
      height: 44px;
      padding: 0;
    }
    .searchbtn.on {
      color: var(--accent);
    }
    /* Active filter chips scroll sideways rather than wrapping onto a second line. */
    .filters {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      padding: 0 var(--s3) var(--s2);
      gap: var(--s2);
    }
    .filters::-webkit-scrollbar,
    .ghfilters::-webkit-scrollbar {
      display: none;
    }
    .filters > :global(.chip) {
      flex: none;
    }
    .filters.bare:not(.searching) {
      display: none;
    }
    .search {
      display: none;
      height: 44px;
      flex-basis: 100%;
      padding: 0 var(--s3);
      gap: var(--s3);
    }
    .searching .search {
      display: flex;
    }
    .searching:not(.bare) {
      flex-wrap: wrap;
    }
    .search input {
      font-size: 16px;
      height: 100%;
    }
    .bulk {
      flex-wrap: wrap;
      gap: var(--s2);
      padding: var(--s2) var(--s3);
    }
    .bulk .badge {
      height: 28px;
      font-size: var(--fs-meta);
      padding: 0 var(--s3);
    }
    .bulk :global(.action.tile) {
      flex: 1 0 calc(20% - 8px);
      min-width: 60px;
      min-height: 52px;
    }
    .bulk .grow {
      display: none;
    }
    .pill {
      min-height: 48px;
      padding: 0 var(--s5);
      font-size: var(--fs-base);
      top: 100px;
    }
    .inbox:not(.thread-open) .detail {
      display: none;
    }
    .inbox.thread-open .list {
      display: none;
    }
  }
  .sort select {
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 2px 4px;
    cursor: pointer;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  @media (max-width: 899px) {
    .sort select {
      font-size: 16px;
      min-height: 36px;
    }
  }
  .ghfilters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 0 var(--s3) var(--s2);
  }
  .ghfilters .sep {
    width: var(--s3);
  }
  .sugfilter {
    flex: none;
  }
  .sugfilter select {
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .sugfilter.on select {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }
  .seg {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    border-radius: 999px;
    padding: 2px 10px;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .seg.on {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }
  @media (max-width: 899px) {
    /* One scrollable line: who, a gap, then kind. */
    .ghfilters {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      border-bottom: 1px solid var(--border);
      padding-bottom: var(--s2);
    }
    .seg {
      flex: none;
      min-height: 40px;
      padding: 4px 14px;
      white-space: nowrap;
    }
    .sugfilter select {
      font-size: 16px;
      min-height: 40px;
      padding: 4px 12px;
    }
  }
</style>
