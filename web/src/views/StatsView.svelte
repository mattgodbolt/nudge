<script lang="ts">
  import type { StatsDTO, StatsTotals } from '../../../shared/types';
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { formatDuration, formatNumber } from '../lib/format';
  import { toasts } from '../lib/stores/toasts.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Icon from '../components/Icon.svelte';
  import UsagePanel from '../components/UsagePanel.svelte';
  import HallOfHeroes from '../components/HallOfHeroes.svelte';
  import InsightsPanel from '../components/InsightsPanel.svelte';

  let stats = $state<StatsDTO | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let scope = $state<'all' | 'mine'>('all');

  const totals = $derived<StatsTotals | null>(stats ? (scope === 'mine' ? stats.mine : stats.totals) : null);
  const incomplete = $derived(totals ? totals.videos - totals.videosWithDetails : 0);

  /** Why the totals could not be loaded; shown in place of them (an empty page would read as "nothing tracked"). */
  let loadError = $state<string | null>(null);
  async function load() {
    loading = true;
    loadError = null;
    try {
      stats = await api.stats();
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Could not load stats';
    } finally {
      loading = false;
    }
  }
  async function fetchMissing() {
    refreshing = true;
    try {
      stats = await api.refreshStats();
    } catch (e) {
      toasts.fail(e, 'Could not fetch video details');
    } finally {
      refreshing = false;
    }
  }
  onMount(() => void load());

  const hours = (s: number) => formatNumber(Math.round(s / 3600));
</script>

<div class="page">
  <header class="head">
    <h1>Stats</h1>
  </header>

  <!-- Insights lead: they are what changes week to week (docs/INSIGHTS.md §4). -->
  <InsightsPanel />

  <header class="head section">
    <h2>Videos</h2>
    <span class="grow"></span>
    {#if stats && stats.mine.videos > 0}
      <div class="seg" role="group" aria-label="Scope">
        <button class="btn sm" class:primary={scope === 'all'} onclick={() => (scope = 'all')}>All tracked</button>
        <button class="btn sm" class:primary={scope === 'mine'} onclick={() => (scope = 'mine')}>My channels</button>
      </div>
    {/if}
  </header>

  {#if loading}
    <p class="meta muted">Loading…</p>
  {:else if loadError && !stats}
    <EmptyState title="Couldn't load the totals" body={loadError}>
      <button class="btn" onclick={() => void load()}>Retry</button>
    </EmptyState>
  {:else if !stats || !totals || stats.totals.videos === 0}
    <EmptyState title="Nothing tracked yet" body="Add a channel, playlist or video and its totals will show up here." />
  {:else}
    <div class="tiles" data-testid="stat-tiles">
      <div class="panel tile">
        <span class="label">Videos</span>
        <span class="value" data-testid="stat-videos">{formatNumber(totals.videos)}</span>
      </div>
      <div class="panel tile" title="{formatNumber(Math.round(totals.durationSeconds / 60))} minutes in total">
        <span class="label">Content</span>
        <span class="value" data-testid="stat-duration">{formatDuration(totals.durationSeconds)}</span>
        <span class="sub">
          {hours(totals.durationSeconds)} hours · {formatNumber(Math.round(totals.durationSeconds / 60))} min
        </span>
      </div>
      <div class="panel tile">
        <span class="label">Views</span>
        <span class="value">{formatNumber(totals.views)}</span>
      </div>
      <div class="panel tile">
        <span class="label">Video likes</span>
        <span class="value" data-testid="stat-video-likes">{formatNumber(totals.videoLikes)}</span>
      </div>
      <div class="panel tile">
        <span class="label">Comments on YouTube</span>
        <span class="value" data-testid="stat-comments">{formatNumber(totals.commentsOnYoutube)}</span>
        <span class="sub">including replies, as YouTube counts them</span>
      </div>
      <div class="panel tile">
        <span class="label">Comments synced</span>
        <span class="value">{formatNumber(totals.commentsSynced)}</span>
        <span class="sub">
          from other people · {formatNumber(totals.inbox)} in inbox · {formatNumber(totals.ownReplies)} replies from you
        </span>
      </div>
      <div class="panel tile">
        <span class="label">Likes on those comments</span>
        <span class="value" data-testid="stat-comment-likes">{formatNumber(totals.commentLikes)}</span>
      </div>
    </div>

    {#if incomplete > 0}
      <div class="panel pad note">
        <span class="meta">
          {formatNumber(incomplete)} video{incomplete === 1 ? '' : 's'} have no length or like count yet, so those totals
          are low.
        </span>
        <span class="grow"></span>
        <button class="btn sm" disabled={refreshing} onclick={() => void fetchMissing()}>
          <Icon name="refresh" size={14} />{refreshing ? 'Fetching…' : 'Fetch now'}
        </button>
      </div>
    {/if}

    <div class="panel tablewrap">
      <table class="grid" data-testid="stats-table">
        <thead>
          <tr>
            <th>Source</th><th class="num">Videos</th><th class="num">Content</th><th class="num">Views</th><th
              class="num"
            >
              Video likes
            </th><th class="num">Comments</th><th class="num">Synced</th><th class="num">Comment likes</th>
          </tr>
        </thead>
        <tbody>
          {#each stats.bySource as s (s.sourceId)}
            <tr>
              <td>
                {s.title}{#if s.isOwn}<span class="meta muted"> · mine</span>{/if}
              </td>
              <td class="num">{formatNumber(s.videos)}</td>
              <td class="num">{formatDuration(s.durationSeconds)}</td>
              <td class="num">{formatNumber(s.views)}</td>
              <td class="num">{formatNumber(s.videoLikes)}</td>
              <td class="num">{formatNumber(s.commentsOnYoutube)}</td>
              <td class="num">{formatNumber(s.commentsSynced)}</td>
              <td class="num">{formatNumber(s.commentLikes)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="meta muted">
      A video listed in several sources counts once in the totals above but appears in each source's row.
    </p>
  {/if}

  <UsagePanel />

  <HallOfHeroes />
</div>

<style>
  .page {
    flex: 1;
    overflow-y: auto;
    padding: var(--s5);
    display: flex;
    flex-direction: column;
    gap: var(--s4);
    max-width: 1000px;
    width: 100%;
    margin: 0 auto;
  }
  /* The page scrolls; its sections must keep their natural height rather than shrink to fit the viewport. */
  .page > :global(*) {
    flex-shrink: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--s2);
  }
  .section {
    margin-top: var(--s4);
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .grow {
    flex: 1;
  }
  .seg {
    display: flex;
    gap: var(--s1);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: var(--s3);
  }
  .tile {
    padding: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s1);
  }
  .label {
    font-size: 12px;
    color: var(--text-muted, inherit);
    opacity: 0.75;
  }
  .value {
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .sub {
    font-size: 12px;
    opacity: 0.65;
  }
  .note {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  /* A narrow screen scrolls the wide per-source table on its own, not the whole page sideways. */
  .tablewrap {
    overflow-x: auto;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
