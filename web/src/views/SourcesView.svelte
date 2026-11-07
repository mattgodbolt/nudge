<script lang="ts">
  import type { PollTier, SourceDTO, VideoDTO } from '../../../shared/types';
  import { api } from '../lib/api';
  import { router } from '../lib/router.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import { sources } from '../lib/stores/sources.svelte';
  import { sync } from '../lib/stores/sync.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';
  import { ago, formatNumber } from '../lib/format';
  import AddSourceForm from '../components/AddSourceForm.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Icon from '../components/Icon.svelte';

  const detailId = $derived(router.route === 'source' ? Number(router.params.id) : null);
  const detail = $derived(detailId !== null ? sources.get(detailId) : undefined);

  const projected = $derived(sources.list.filter((s) => s.enabled).reduce((n, s) => n + s.projectedUnitsPerDay, 0));
  const budget = $derived(settings.value?.dailyQuotaBudget ?? 0);
  const icon = (k: SourceDTO['kind']) => (k === 'channel' ? 'channel' : k === 'playlist' ? 'playlist' : 'video');

  let videos = $state<VideoDTO[]>([]);
  let videosLoading = $state(false);
  let confirmRemove = $state<number | null>(null);

  $effect(() => {
    const id = detailId;
    videos = [];
    if (id === null || Number.isNaN(id)) return;
    videosLoading = true;
    let cancelled = false;
    api
      .sourceVideos(id)
      .then((v) => !cancelled && (videos = v))
      .catch((e) => toasts.error(e instanceof Error ? e.message : 'Could not load videos'))
      .finally(() => !cancelled && (videosLoading = false));
    return () => (cancelled = true);
  });

  async function setTier(v: VideoDTO, value: string) {
    const tierOverride = value === '' ? null : (value as PollTier);
    const prev = videos;
    videos = videos.map((x) => (x.id === v.id ? { ...x, tierOverride, tier: tierOverride ?? x.tier } : x));
    try {
      const updated = await api.patchVideo(v.id, tierOverride);
      videos = videos.map((x) => (x.id === v.id ? updated : x));
    } catch (e) {
      videos = prev;
      toasts.error(e instanceof Error ? e.message : 'Could not update tier');
    }
  }

  async function remove(s: SourceDTO, purge: boolean) {
    confirmRemove = null;
    await sources.remove(s.id, purge);
    if (router.route === 'source') router.navigate('sources');
  }
</script>

<div class="page">
  {#if detail}
    <header class="head">
      <button class="btn ghost sm" onclick={() => router.navigate('sources')}
        ><Icon name="chevron-left" size={14} /> Sources</button
      >
      <h1>{detail.title ?? detail.ytId}</h1>
      <span class="badge">{detail.kind}</span>
      {#if detail.isOwn}<span class="badge accent">Mine</span>{/if}
      <span class="grow"></span>
      <button class="btn sm" onclick={() => void sync.run({ scope: 'source', id: detail.id }, 'Source sync started')}
        ><Icon name="refresh" size={13} /> Sync source</button
      >
    </header>
    {#if detail.lastError}<p class="err meta">{detail.lastError}</p>{/if}
    <div class="panel tablewrap">
      <table class="grid" data-testid="video-table">
        <thead
          ><tr><th>Video</th><th>Tier</th><th>Override</th><th>Last synced</th><th class="num">Inbox</th><th></th></tr
          ></thead
        >
        <tbody>
          {#each videos as v (v.id)}
            <tr>
              <td class="vtitle">
                <a
                  href="https://www.youtube.com/watch?v={v.id}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="truncate">{v.title || v.id}</a
                >
                {#if v.commentsDisabled}<span class="badge warn">Comments disabled</span>{/if}
                {#if v.missing}<span class="badge warn">Missing</span>{/if}
                {#if v.lastError}<span class="badge warn" title={v.lastError}>Error</span>{/if}
              </td>
              <td><span class="badge">{v.tier}</span></td>
              <td>
                <select
                  class="select"
                  aria-label="Tier override"
                  value={v.tierOverride ?? ''}
                  onchange={(e) => void setTier(v, e.currentTarget.value)}
                >
                  <option value="">Auto</option>
                  {#each ['hot', 'warm', 'cold', 'frozen', 'paused'] as t (t)}<option value={t}>{t}</option>{/each}
                </select>
              </td>
              <td class="muted">{ago(v.lastSyncedAt, sync.now)}</td>
              <td class="num">{v.inboxCount}</td>
              <td class="num"
                ><button
                  class="btn sm"
                  onclick={() => void sync.run({ scope: 'video', id: v.id }, 'Video sync started')}>Sync now</button
                ></td
              >
            </tr>
          {:else}
            <tr
              ><td colspan="6" class="muted center"
                >{videosLoading ? 'Loading…' : 'No videos yet. They appear after the first sync.'}</td
              ></tr
            >
          {/each}
        </tbody>
      </table>
    </div>
  {:else if router.route === 'source'}
    <EmptyState title="Source not found" body="It may have been removed.">
      <button class="btn" onclick={() => router.navigate('sources')}>Back to sources</button>
    </EmptyState>
  {:else}
    <header class="head">
      <h1>Sources</h1>
      <span class="grow"></span>
    </header>
    <div class="panel pad"><AddSourceForm /></div>
    <p class="meta muted">
      Your own channels are marked <span class="badge accent">Mine</span>. Manage them under
      <a
        class="link"
        href="/settings"
        onclick={(e) => {
          e.preventDefault();
          router.navigate('settings');
        }}>Settings &rsaquo; My channels</a
      >.
    </p>

    {#if budget > 0 && projected > 0}
      <p class="meta" class:over={projected > budget}>
        Projected usage ~{formatNumber(Math.round(projected))} units/day of {formatNumber(budget)} budget{projected >
        budget
          ? '. Consider pausing busy sources or colder tiers.'
          : '.'}
      </p>
    {/if}

    {#if sources.list.length === 0}
      <EmptyState title="No sources yet" body="Add a video, playlist or channel above to start collecting comments." />
    {:else}
      <div class="panel tablewrap">
        <table class="grid" data-testid="sources-table">
          <thead
            ><tr
              ><th>Source</th><th class="num">Videos</th><th class="num">Inbox</th><th class="num">Units/day</th><th
                >On</th
              ><th></th></tr
            ></thead
          >
          <tbody>
            {#each sources.list as s (s.id)}
              <tr class:off={!s.enabled} data-testid="source-row">
                <td>
                  <a
                    class="stitle"
                    href="/sources/{s.id}"
                    onclick={(e) => {
                      e.preventDefault();
                      router.navigate('source', {}, { id: s.id });
                    }}
                  >
                    <Icon name={icon(s.kind)} size={14} /><span class="truncate">{s.title ?? s.ytId}</span>
                    {#if s.isOwn}<span class="badge accent" data-testid="own-badge">Mine</span>{/if}
                  </a>
                  {#if s.lastError}<div class="err meta truncate" title={s.lastError}>{s.lastError}</div>{/if}
                </td>
                <td class="num">{s.videoCount}</td>
                <td class="num">{s.inboxCount}</td>
                <td class="num muted">{formatNumber(Math.round(s.projectedUnitsPerDay))}</td>
                <td
                  ><input
                    type="checkbox"
                    checked={s.enabled}
                    aria-label="Enabled"
                    onchange={(e) => void sources.patch(s.id, { enabled: e.currentTarget.checked })}
                  /></td
                >
                <td class="num actions">
                  <button
                    class="btn sm"
                    onclick={() => void sync.run({ scope: 'source', id: s.id }, 'Source sync started')}>Sync</button
                  >
                  {#if confirmRemove === s.id}
                    <button class="btn sm danger" onclick={() => void remove(s, false)}>Remove</button>
                    <button
                      class="btn sm danger"
                      onclick={() => void remove(s, true)}
                      title="Also delete its stored comments">Remove + purge</button
                    >
                    <button class="btn sm ghost" onclick={() => (confirmRemove = null)}>Cancel</button>
                  {:else}
                    <button class="btn sm ghost" aria-label="Remove source" onclick={() => (confirmRemove = s.id)}
                      ><Icon name="trash" size={13} /></button
                    >
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page {
    flex: 1;
    overflow-y: auto;
    padding: var(--s5);
    display: flex;
    flex-direction: column;
    gap: var(--s4);
    max-width: 980px;
    width: 100%;
    margin: 0 auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .grow {
    flex: 1;
  }
  .pad {
    padding: var(--s4);
  }
  .tablewrap {
    overflow-x: auto;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .center {
    text-align: center;
    padding: var(--s5);
  }
  .off {
    opacity: 0.55;
  }
  .stitle {
    display: flex;
    gap: var(--s2);
    align-items: center;
    font-weight: 500;
    max-width: 360px;
  }
  .stitle:hover {
    text-decoration: underline;
  }
  .link {
    text-decoration: underline;
  }
  .err {
    color: var(--danger);
  }
  .over {
    color: var(--warn);
  }
  .vtitle {
    display: flex;
    gap: var(--s2);
    align-items: center;
    max-width: 440px;
  }
  .vtitle a:hover {
    text-decoration: underline;
  }
  .actions {
    white-space: nowrap;
  }
</style>
