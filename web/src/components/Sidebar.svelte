<script lang="ts">
  import { tick } from 'svelte';
  import { router, type RouteName } from '../lib/router.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { feeds } from '../lib/stores/feeds.svelte';
  import { labels, labelColorVar } from '../lib/stores/labels.svelte';
  import { sources } from '../lib/stores/sources.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { assistant } from '../lib/stores/assistant.svelte';
  import { phone } from '../lib/phone.svelte';
  import { resync } from '../lib/resync.svelte';
  import { formatNumber } from '../lib/format';
  import Icon from './Icon.svelte';
  import SyncIndicator from './SyncIndicator.svelte';
  import QuotaMeter from './QuotaMeter.svelte';
  import Kbd from './Kbd.svelte';

  /** Which GitHub owners are expanded. A feed you are looking at is always shown open. */
  let expanded = $state<Set<number>>(new Set());
  try {
    expanded = new Set(JSON.parse(localStorage.getItem('nudge-sidebar-open-feeds') ?? '[]') as number[]);
  } catch {
    /* storage unavailable */
  }
  const isOpen = (id: number) => expanded.has(id) || router.query.feed === String(id);
  function toggle(id: number) {
    const next = new Set(expanded);
    if (isOpen(id)) next.delete(id);
    else next.add(id);
    expanded = next;
    try {
      localStorage.setItem('nudge-sidebar-open-feeds', JSON.stringify([...next]));
    } catch {
      /* storage unavailable */
    }
  }
  /** Repositories under an owner that have something waiting, busiest first; the one you are viewing stays listed. */
  function reposOf(owner: string): { full: string; name: string; n: number }[] {
    const prefix = `${owner.toLowerCase()}/`;
    const out = Object.entries(inbox.counts.byRepo)
      .filter(([full]) => full.toLowerCase().startsWith(prefix))
      .map(([full, n]) => ({ full, name: full.slice(prefix.length), n }));
    const cur = router.query.repo;
    if (cur && cur.toLowerCase().startsWith(prefix) && !out.some((r) => r.full === cur)) {
      out.push({ full: cur, name: cur.slice(prefix.length), n: 0 });
    }
    return out.sort((x, y) => y.n - x.n || x.name.localeCompare(y.name));
  }

  const views = $derived([
    {
      route: 'inbox' as RouteName,
      label: 'Inbox',
      icon: 'inbox' as const,
      count: inbox.counts.inbox,
      testid: 'sidebar-count-inbox',
      keys: 'g i',
    },
    {
      route: 'snoozed' as RouteName,
      label: 'Snoozed',
      icon: 'clock' as const,
      count: inbox.counts.snoozed,
      testid: 'sidebar-count-snoozed',
      keys: 'g z',
    },
    {
      route: 'done' as RouteName,
      label: 'Done',
      icon: 'check' as const,
      count: inbox.counts.done,
      testid: 'sidebar-count-done',
      keys: 'g d',
    },
    {
      route: 'all' as RouteName,
      label: 'All',
      icon: 'layers' as const,
      count: inbox.counts.all,
      testid: 'sidebar-count-all',
      keys: 'g a',
    },
  ]);

  let navEl: HTMLElement | undefined = $state();
  // On phones the views form a horizontal strip: keep the current one scrolled into view.
  $effect(() => {
    void router.route;
    void router.params.id;
    void activeSource;
    void tick().then(() => {
      const el = navEl?.querySelector<HTMLElement>('.item.active');
      if (el && phone.value) el.scrollIntoView({ inline: 'center', block: 'nearest' });
    });
  });
  const activeSource = $derived(router.route === 'inbox' ? router.query.source : undefined);
  const sourceIcon = (k: string) => (k === 'channel' ? 'channel' : k === 'playlist' ? 'playlist' : 'video');
</script>

<nav class="sidebar" aria-label="Main">
  <div class="brand">
    <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M3 17h7l2 4h8l2-4h7v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="currentColor" />
      <circle cx="16" cy="8" r="5" fill="var(--accent)" />
    </svg>
    <span class="name">Nudge</span>
    <button
      class="btn ghost sm refresh"
      class:busy={resync.busy}
      onclick={() => void resync.run()}
      disabled={resync.busy}
      title="Refresh (Shift+R)"
      aria-label="Refresh"
      data-testid="refresh"
    >
      <Icon name="refresh" size={phone.value ? 22 : 15} />
    </button>
    <button
      class="btn ghost sm collapse"
      onclick={() => ui.toggleSidebar()}
      title="Toggle sidebar ([)"
      aria-label="Toggle sidebar"
    >
      <Icon name="sidebar" size={15} />
    </button>
  </div>

  <button
    class="btn ghost search"
    onclick={() => (ui.paletteOpen = true)}
    aria-label="Jump to… (search commands and views)"
  >
    <Icon name="search" size={phone.value ? 22 : 14} /><span class="grow">Jump to…</span><Kbd keys="$mod+k" />
  </button>

  <button class="btn ghost search tell" data-testid="tell-nudge" onclick={() => assistant.show()}>
    <Icon name="mic" size={14} /><span class="grow">Tell Nudge…</span><Kbd label="c" />
  </button>

  <div class="nav" bind:this={navEl}>
    <div class="group">
      {#each views as v (v.route)}
        <a
          class="item"
          class:active={router.route === v.route && !activeSource}
          href="/{v.route}"
          onclick={(e) => {
            e.preventDefault();
            router.navigate(v.route);
            ui.pane = 'list';
          }}
        >
          <Icon name={v.icon} />
          <span class="grow">{v.label}</span>
          <span
            class="count"
            class:strong={v.route === 'inbox' && v.count > 0}
            class:zero={v.route === 'snoozed' && v.count === 0}
            data-testid={v.testid}>{formatNumber(v.count)}</span
          >
        </a>
      {/each}
    </div>

    <div class="group scroll">
      {#if labels.list.length > 0}
        <div class="label head">Labels</div>
        {#each labels.list as l (l.id)}
          {@const n = inbox.counts.byLabel[l.id] ?? 0}
          <a
            class="item sub"
            class:active={router.route === 'label' && router.params.id === String(l.id)}
            href="/label/{l.id}"
            data-testid="sidebar-label"
            onclick={(e) => {
              e.preventDefault();
              router.navigate('label', {}, { id: l.id });
              ui.pane = 'list';
            }}
          >
            <i class="dot" style:background={labelColorVar(l.color)}></i>
            <span class="grow truncate">{l.name}</span>
            {#if n > 0}<span class="count" data-testid="sidebar-label-count">{formatNumber(n)}</span>{/if}
          </a>
        {/each}
      {/if}
      <div class="label head">Sources</div>
      <div class="label subhead">YouTube</div>
      {#each sources.list as s (s.id)}
        {@const n = inbox.counts.bySource[s.id] ?? s.inboxCount}
        <a
          class="item sub"
          class:active={activeSource === String(s.id)}
          class:off={!s.enabled}
          href="/inbox?source={s.id}"
          onclick={(e) => {
            e.preventDefault();
            router.navigate('inbox', { source: String(s.id) });
            ui.pane = 'list';
          }}
        >
          <Icon name={sourceIcon(s.kind)} size={14} />
          <span class="grow truncate">{s.title ?? s.ytId}</span>
          {#if n > 0}<span class="count">{formatNumber(n)}</span>{/if}
        </a>
      {:else}
        <div class="faint meta pad">No sources yet</div>
      {/each}
      {#if feeds.list.length > 0}
        <div class="label subhead">GitHub</div>
        {#each feeds.list as f (f.id)}
          {@const n = inbox.counts.byFeed[f.id] ?? f.inboxCount}
          {@const repos = reposOf(f.owner)}
          {@const open = isOpen(f.id)}
          <div class="feedrow">
            <button
              type="button"
              class="chev"
              class:closed={!open}
              aria-label="{open ? 'Collapse' : 'Expand'} {f.owner}"
              aria-expanded={open}
              data-testid="feed-toggle"
              onclick={() => toggle(f.id)}><Icon name="chevron-down" size={12} /></button
            >
            <a
              class="item sub grow"
              class:active={router.route === 'inbox' && router.query.feed === String(f.id) && !router.query.repo}
              class:off={!f.enabled}
              href="/inbox?feed={f.id}"
              data-testid="sidebar-feed"
              onclick={(e) => {
                e.preventDefault();
                router.navigate('inbox', { feed: String(f.id) });
                ui.pane = 'list';
              }}
            >
              <Icon name="list" size={14} />
              <span class="grow truncate">{f.owner}</span>
              {#if f.lastError}<span class="warn" title={f.lastError} data-testid="feed-error">!</span>{/if}
              {#if n > 0}<span class="count" data-testid="sidebar-feed-count">{formatNumber(n)}</span>{/if}
            </a>
          </div>
          {#if open}
            {#each repos as r (r.full)}
              <a
                class="item sub repo"
                class:active={router.route === 'inbox' && router.query.repo === r.full}
                href="/inbox?feed={f.id}&repo={encodeURIComponent(r.full)}"
                data-testid="sidebar-repo"
                title={r.full}
                onclick={(e) => {
                  e.preventDefault();
                  router.navigate('inbox', { feed: String(f.id), repo: r.full });
                  ui.pane = 'list';
                }}
              >
                <span class="grow truncate">{r.name}</span>
                {#if r.n > 0}<span class="count" data-testid="sidebar-repo-count">{formatNumber(r.n)}</span>{/if}
              </a>
            {:else}
              <div class="faint meta pad repo-empty">Nothing waiting</div>
            {/each}
          {/if}
        {/each}
      {/if}
      <div class="label subhead">Todos</div>
      <a
        class="item sub"
        class:active={router.route === 'inbox' && router.query.kind === 'todo'}
        href="/inbox?kind=todo"
        data-testid="sidebar-todos"
        onclick={(e) => {
          e.preventDefault();
          router.navigate('inbox', { kind: 'todo' });
          ui.pane = 'list';
        }}
      >
        <Icon name="check" size={14} />
        <span class="grow truncate">Todos</span>
        {#if inbox.counts.todos > 0}<span class="count" data-testid="sidebar-todos-count"
            >{formatNumber(inbox.counts.todos)}</span
          >{/if}
      </a>
    </div>
  </div>

  <div class="group foot">
    <a
      class="item"
      class:active={router.route === 'sources' || router.route === 'source'}
      href="/sources"
      aria-label="Manage sources"
      onclick={(e) => {
        e.preventDefault();
        router.navigate('sources');
      }}><Icon name="list" /><span class="grow">Manage sources</span></a
    >
    <a
      class="item"
      class:active={router.route === 'stats'}
      href="/stats"
      aria-label="Stats"
      onclick={(e) => {
        e.preventDefault();
        router.navigate('stats');
      }}><Icon name="chart" /><span class="grow">Stats</span></a
    >
    <a
      class="item"
      class:active={router.route === 'settings'}
      href="/settings"
      aria-label="Settings"
      onclick={(e) => {
        e.preventDefault();
        router.navigate('settings');
      }}><Icon name="settings" /><span class="grow">Settings</span></a
    >
    <SyncIndicator />
    <QuotaMeter />
  </div>
</nav>

<style>
  .sidebar {
    width: 220px;
    flex: none;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    padding: var(--s2);
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
    min-height: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s1) var(--s2);
  }
  .logo {
    width: 20px;
    height: 20px;
    flex: none;
    color: var(--text);
  }
  .name {
    font-weight: 600;
    letter-spacing: -0.01em;
    flex: 1;
  }
  .search {
    justify-content: flex-start;
    border-color: var(--border);
    background: var(--bg-elev);
    gap: var(--s2);
    font-weight: 400;
  }
  .grow {
    flex: 1;
    min-width: 0;
    text-align: left;
  }
  .refresh.busy :global(svg) {
    animation: refresh-spin 0.9s linear infinite;
    color: var(--accent);
  }
  @keyframes refresh-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .group.scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .head {
    padding: var(--s2) var(--s2) var(--s1);
  }
  .pad {
    padding: 0 var(--s2);
  }
  .foot {
    border-top: 1px solid var(--border);
    padding-top: var(--s2);
  }
  .item {
    display: flex;
    align-items: center;
    gap: var(--s2);
    height: 28px;
    padding: 0 var(--s2);
    border-radius: var(--radius);
    color: var(--text-muted);
    cursor: pointer;
    transition: background var(--dur) var(--ease);
  }
  .item.sub {
    height: 26px;
    font-size: var(--fs-meta);
  }
  .item.off {
    opacity: 0.5;
  }
  .item:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .item.active {
    background: var(--bg-hover);
    color: var(--text);
    font-weight: 500;
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .count {
    font-size: var(--fs-label);
    font-variant-numeric: tabular-nums;
    color: var(--text-faint);
  }
  .dot {
    width: 9px;
    height: 9px;
    margin: 0 2.5px;
    border-radius: 50%;
    flex: none;
  }
  .count.zero {
    opacity: 0.45;
  }
  .count.strong {
    color: var(--text);
    font-weight: 600;
  }
  .nav {
    display: contents;
  }
  /* Phone: row 1 = brand + big icon buttons (search, sources, stats, settings); row 2 = a swipeable strip
     of every view (Inbox, Snoozed, Done, All, each label, each source) as 44px+ chips. */
  .subhead {
    padding: var(--s2) var(--s2) 2px var(--s3);
    font-size: var(--fs-meta);
    color: var(--text-faint, var(--text-muted));
  }
  .feedrow {
    display: flex;
    align-items: center;
  }
  .chev {
    flex: none;
    width: 18px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
  }
  .chev.closed :global(svg) {
    transform: rotate(-90deg);
  }
  .repo {
    padding-left: 34px;
  }
  .repo-empty {
    padding-left: 34px;
  }
  @media (max-width: 899px) {
    .chev {
      width: 32px;
      height: 44px;
    }
    .tell {
      display: none;
    }
    .sidebar {
      width: 100%;
      height: auto;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--s1) var(--s2);
      padding: calc(env(safe-area-inset-top) + var(--s1)) calc(var(--s2) + env(safe-area-inset-right)) var(--s2)
        calc(var(--s2) + env(safe-area-inset-left));
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
    .collapse,
    .head,
    .foot :global(.sync),
    .foot > :global(:not(a)) {
      display: none;
    }
    .brand {
      order: 0;
      flex: 1;
      min-width: 0;
    }
    .name {
      font-size: 16px;
    }
    .refresh {
      flex: none;
      width: 48px;
      height: 48px;
      padding: 0;
      justify-content: center;
      border: 1px solid var(--border);
      background: var(--bg-elev);
    }
    .search {
      order: 1;
      flex: none;
      width: 48px;
      height: 48px;
      padding: 0;
      justify-content: center;
    }
    .search .grow {
      display: none;
    }
    .foot {
      order: 2;
      display: flex;
      flex-direction: row;
      gap: var(--s2);
      border-top: 0;
      padding: 0;
    }
    .foot .item {
      width: 48px;
      height: 48px;
      padding: 0;
      justify-content: center;
      border: 1px solid var(--border);
      background: var(--bg-elev);
    }
    .foot .item .grow {
      display: none;
    }
    .foot .item :global(svg) {
      width: 22px;
      height: 22px;
    }
    .nav {
      order: 3;
      flex: 1 0 100%;
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: var(--s2);
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scroll-snap-type: x proximity;
      scrollbar-width: none;
      margin: 0 calc(var(--s2) * -1);
      padding: var(--s1) var(--s2);
    }
    .nav::-webkit-scrollbar {
      display: none;
    }
    .group,
    .group.scroll {
      display: contents;
    }
    .nav .item,
    .nav .item.sub {
      flex: none;
      height: 48px;
      padding: 0 var(--s4);
      gap: var(--s2);
      font-size: 15px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--bg-elev);
      scroll-snap-align: center;
      white-space: nowrap;
    }
    .nav .item .grow {
      flex: none;
      max-width: 160px;
    }
    .nav .item.active {
      background: var(--text);
      color: var(--bg);
      border-color: var(--text);
      box-shadow: none;
    }
    .nav .item.active .count {
      color: var(--bg);
      opacity: 0.8;
    }
    .nav .pad {
      flex: none;
      padding: 0 var(--s3);
    }
    .foot .item.active {
      border-color: var(--text);
      box-shadow: none;
    }
  }
  .warn {
    color: var(--warn);
    font-weight: 700;
  }
</style>
