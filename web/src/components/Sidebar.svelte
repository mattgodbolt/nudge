<script lang="ts">
  import { router, type RouteName } from '../lib/router.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { sources } from '../lib/stores/sources.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { formatNumber } from '../lib/format';
  import Icon from './Icon.svelte';
  import SyncIndicator from './SyncIndicator.svelte';
  import QuotaMeter from './QuotaMeter.svelte';
  import Kbd from './Kbd.svelte';

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

  const activeSource = $derived(router.route === 'inbox' ? router.query.source : undefined);
  const sourceIcon = (k: string) => (k === 'channel' ? 'channel' : k === 'playlist' ? 'playlist' : 'video');
</script>

<nav class="sidebar" aria-label="Main">
  <div class="brand">
    <span class="logo" aria-hidden="true"></span>
    <span class="name">Youtubey</span>
    <button
      class="btn ghost sm collapse"
      onclick={() => ui.toggleSidebar()}
      title="Toggle sidebar ([)"
      aria-label="Toggle sidebar"
    >
      <Icon name="sidebar" size={15} />
    </button>
  </div>

  <button class="btn ghost search" onclick={() => (ui.paletteOpen = true)}>
    <Icon name="search" size={14} /><span class="grow">Jump to…</span><Kbd keys="$mod+k" />
  </button>

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
        <span class="count" class:strong={v.route === 'inbox' && v.count > 0} data-testid={v.testid}
          >{formatNumber(v.count)}</span
        >
      </a>
    {/each}
  </div>

  <div class="group scroll">
    <div class="label head">Sources</div>
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
  </div>

  <div class="group foot">
    <a
      class="item"
      class:active={router.route === 'sources' || router.route === 'source'}
      href="/sources"
      onclick={(e) => {
        e.preventDefault();
        router.navigate('sources');
      }}><Icon name="list" /><span class="grow">Manage sources</span></a
    >
    <a
      class="item"
      class:active={router.route === 'stats'}
      href="/stats"
      onclick={(e) => {
        e.preventDefault();
        router.navigate('stats');
      }}><Icon name="chart" /><span class="grow">Stats</span></a
    >
    <a
      class="item"
      class:active={router.route === 'settings'}
      href="/settings"
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
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: var(--accent);
    position: relative;
  }
  .logo::after {
    content: '';
    position: absolute;
    left: 7px;
    top: 5px;
    border-left: 6px solid #fff;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
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
  .count.strong {
    color: var(--text);
    font-weight: 600;
  }
  @media (max-width: 899px) {
    .sidebar {
      width: 100%;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
    .group.scroll,
    .search,
    .collapse {
      display: none;
    }
    .group {
      flex-direction: row;
      flex-wrap: wrap;
    }
    .foot {
      display: none;
    }
  }
</style>
