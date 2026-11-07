<script lang="ts">
  import { api } from '../lib/api';
  import { settings } from '../lib/stores/settings.svelte';
  import { sources } from '../lib/stores/sources.svelte';
  import Avatar from '../components/Avatar.svelte';
  import { sync } from '../lib/stores/sync.svelte';
  import { theme, type ThemePref } from '../lib/stores/theme.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';
  import { formatNumber, until } from '../lib/format';

  const s = $derived(settings.value);

  let keyInput = $state('');
  let keyBusy = $state(false);
  let keyResult = $state<{ ok: boolean; message: string } | null>(null);
  let chanInput = $state('');
  let chanError = $state('');
  let chanBusy = $state(false);

  async function testKey() {
    keyBusy = true;
    keyResult = null;
    try {
      keyResult = await api.testKey(keyInput.trim() || undefined);
    } catch (e) {
      keyResult = { ok: false, message: e instanceof Error ? e.message : 'Test failed' };
    } finally {
      keyBusy = false;
    }
  }
  async function saveKey() {
    if (!keyInput.trim()) return;
    if (await settings.save({ apiKey: keyInput.trim() })) {
      keyInput = '';
      keyResult = null;
      toasts.push({ message: 'API key saved', kind: 'success', timeoutMs: 2500 });
    }
  }
  async function removeKey() {
    if (await settings.save({ apiKey: null })) toasts.push({ message: 'Stored API key removed', timeoutMs: 2500 });
  }

  async function addChannel(e: Event) {
    e.preventDefault();
    const v = chanInput.trim();
    if (!v || chanBusy) return;
    chanBusy = true;
    chanError = (await settings.addOwnChannel(v)) ?? '';
    chanBusy = false;
    if (!chanError) {
      chanInput = '';
      void sources.load().catch(() => {});
    }
  }
  function num(
    e: Event & { currentTarget: HTMLInputElement },
    field: 'dailyQuotaBudget' | 'manualReserve' | 'backfillDays',
  ) {
    const n = Math.max(0, Math.floor(Number(e.currentTarget.value)));
    if (Number.isFinite(n) && s && n !== s[field]) void settings.save({ [field]: n });
  }

  const sourceLabel = {
    env: 'YOUTUBE_API_KEY environment variable',
    settings: 'Settings (stored in the local database)',
    file: '~/.youtubey-key',
  } as const;
</script>

<div class="page">
  <h1>Settings</h1>
  {#if s}
    <section class="panel sec" data-testid="settings-key">
      <h2>YouTube API key</h2>
      <p class="muted meta">
        {#if s.apiKey.configured}
          Using key ending <code>…{s.apiKey.last4}</code> from
          <strong>{sourceLabel[s.apiKey.source ?? 'settings']}</strong>.
          {#if s.apiKey.source !== 'settings'}An env or file key takes priority over one saved here.{/if}
        {:else}
          No key configured. Sync is disabled until you add one.
        {/if}
      </p>
      <div class="line">
        <input
          class="input mono grow"
          type="password"
          placeholder="Paste a key to test or replace…"
          bind:value={keyInput}
          autocomplete="off"
          aria-label="API key"
        />
        <button class="btn" onclick={testKey} disabled={keyBusy || (!keyInput.trim() && !s.apiKey.configured)}
          >{keyBusy ? 'Testing…' : 'Test'}</button
        >
        <button class="btn primary" onclick={saveKey} disabled={!keyInput.trim()}>Save</button>
        {#if s.apiKey.source === 'settings'}<button class="btn danger" onclick={removeKey}>Remove</button>{/if}
      </div>
      {#if keyResult}<p class="meta" class:ok={keyResult.ok} class:bad={!keyResult.ok}>{keyResult.message}</p>{/if}
    </section>

    <section class="panel sec">
      <h2>My channels</h2>
      <p class="muted meta">
        Paste your channel URL or @handle. Comments from your channels never land in the inbox, replying from them marks
        earlier comments as answered, and their uploads are tracked as a source.
      </p>
      <div class="chips" data-testid="own-channels">
        {#each s.ownChannels as c (c.id)}
          <span class="chip" data-testid="own-channel-chip">
            <Avatar name={c.title ?? c.id} url={c.thumbnailUrl} size={18} />
            <span title={c.id}>{c.title ?? c.id}</span>
            <button aria-label="Remove {c.title ?? c.id}" onclick={() => void settings.removeOwnChannel(c.id)}>×</button
            >
          </span>
        {:else}
          <span class="faint meta">None yet.</span>
        {/each}
      </div>
      <form class="line" onsubmit={addChannel}>
        <input
          class="input grow"
          placeholder="https://www.youtube.com/@yourchannel or @yourchannel"
          bind:value={chanInput}
          aria-label="Channel URL or @handle"
          spellcheck="false"
          autocomplete="off"
          data-testid="own-channel-input"
        />
        <button class="btn" type="submit" disabled={!chanInput.trim() || chanBusy}
          >{chanBusy ? 'Finding…' : 'Add'}</button
        >
      </form>
      {#if chanError}<p class="bad meta" role="alert">{chanError}</p>{/if}
    </section>

    <section class="panel sec">
      <h2>Syncing</h2>
      <label class="field"
        ><span>Background polling</span>
        <input
          type="checkbox"
          checked={s.pollEnabled}
          onchange={(e) => void settings.save({ pollEnabled: e.currentTarget.checked })}
        />
      </label>
      <label class="field"
        ><span>Daily quota budget <small class="faint">units</small></span>
        <input
          class="input num"
          type="number"
          min="0"
          step="500"
          value={s.dailyQuotaBudget}
          onchange={(e) => num(e, 'dailyQuotaBudget')}
        />
      </label>
      <label class="field"
        ><span>Manual reserve <small class="faint">units kept for manual syncs</small></span>
        <input
          class="input num"
          type="number"
          min="0"
          step="100"
          value={s.manualReserve}
          onchange={(e) => num(e, 'manualReserve')}
        />
      </label>
      <label class="field"
        ><span>Backfill <small class="faint">days of history for new sources</small></span>
        <input
          class="input num"
          type="number"
          min="0"
          max="3650"
          value={s.backfillDays}
          onchange={(e) => num(e, 'backfillDays')}
        />
      </label>
      {#if sync.quota}
        <p class="meta muted">
          Today (Pacific): <span class="mono">{formatNumber(sync.quota.used)}</span> of
          <span class="mono">{formatNumber(sync.quota.budget)}</span>
          units used.
          {#if sync.blocked}Blocked until {sync.quota.blockedUntil
              ? until(sync.quota.blockedUntil, sync.now)
              : ''}.{/if}
        </p>
      {/if}
    </section>

    <section class="panel sec">
      <h2>Appearance</h2>
      <div class="seg" role="group" aria-label="Theme">
        {#each [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as [v, l] (v)}
          <button
            class="segbtn"
            class:on={theme.preference === v}
            aria-pressed={theme.preference === v}
            onclick={() => theme.set(v as ThemePref)}>{l}</button
          >
        {/each}
      </div>
      <p class="faint meta">Press <kbd class="mono">t</kbd> anywhere to cycle.</p>
    </section>

    {#if s.demo}
      <p class="meta muted">Demo mode is on: data comes from a simulated YouTube and nothing is sent anywhere.</p>
    {/if}
  {:else}
    <p class="muted">Loading…</p>
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
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  h2 {
    font-size: 14px;
    font-weight: 600;
  }
  .sec {
    padding: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  .line {
    display: flex;
    gap: var(--s2);
  }
  .grow {
    flex: 1;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .chip button {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--text-faint);
    padding: 0;
  }
  .chip button:hover {
    color: var(--danger);
  }
  .field {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s3);
  }
  .num {
    width: 110px;
    text-align: right;
  }
  .ok {
    color: var(--success);
  }
  .bad {
    color: var(--danger);
  }
  .seg {
    display: inline-flex;
    width: max-content;
  }
  .segbtn {
    height: 28px;
    padding: 0 14px;
    border: 1px solid var(--border-strong);
    background: var(--bg-elev);
    cursor: pointer;
    color: var(--text-muted);
  }
  .segbtn:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
  }
  .segbtn:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
  }
  .segbtn + .segbtn {
    margin-left: -1px;
  }
  .segbtn.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
    position: relative;
    z-index: 1;
  }
</style>
