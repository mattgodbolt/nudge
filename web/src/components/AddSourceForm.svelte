<script lang="ts">
  import { parseSourceInput } from '../../../shared/youtube-urls';
  import type { ImportMode } from '../../../shared/types';
  import { sources } from '../lib/stores/sources.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';
  import { router } from '../lib/router.svelte';
  import Icon from './Icon.svelte';

  let { autofocus = false, compact = false }: { autofocus?: boolean; compact?: boolean } = $props();

  let value = $state('');
  let isOwn = $state(false);
  let importMode = $state<ImportMode>('recent');
  let busy = $state(false);
  let input: HTMLInputElement | undefined = $state();

  const parsed = $derived(parseSourceInput(value));
  const kindLabel = $derived(parsed ? { channel: 'Channel', playlist: 'Playlist', video: 'Video' }[parsed.kind] : null);
  const backfill = $derived(settings.value?.backfillDays ?? 14);

  $effect(() => {
    void ui.addSourceFocusTick;
    if (ui.addSourceFocusTick > 0 || autofocus) input?.focus();
  });
  // Own-channel only makes sense for channels.
  $effect(() => {
    if (parsed && parsed.kind !== 'channel') isOwn = false;
  });

  async function submit(e: Event) {
    e.preventDefault();
    if (!parsed || busy) return;
    busy = true;
    if (isOwn) {
      // Same flow as Settings > My channels: resolve, register as mine, track uploads.
      const err = await settings.addOwnChannel(value.trim(), importMode);
      if (err) toasts.error(err);
      else {
        toasts.success('Channel added as yours', 3500);
        await sources.load().catch(() => {});
        value = '';
        isOwn = false;
      }
      busy = false;
      return;
    }
    const s = await sources.add(value.trim(), { importMode });
    busy = false;
    if (s) {
      value = '';
      isOwn = false;
      if (router.route === 'sources') router.navigate('source', {}, { id: s.id });
    }
  }
</script>

<form class="add" class:compact onsubmit={submit} data-testid="add-source">
  <div class="line">
    <input
      bind:this={input}
      bind:value
      class="input grow"
      placeholder="Paste a YouTube video, playlist or channel URL, or @handle"
      aria-label="Source URL or id"
      spellcheck="false"
      autocomplete="off"
      data-testid="add-source-input"
    />
    <button class="btn primary" type="submit" disabled={!parsed || busy}>
      <Icon name="plus" size={14} />{busy ? 'Adding…' : 'Add source'}
    </button>
  </div>
  <div class="preview meta" data-testid="source-preview" aria-live="polite">
    {#if !value.trim()}
      <span class="faint">Accepts watch / youtu.be / shorts URLs, playlist links, /channel/UC… and @handles.</span>
    {:else if parsed}
      <span class="badge accent">{kindLabel}</span>
      <span class="mono">{parsed.ytId}</span>
    {:else}
      <span class="bad">Doesn't look like a YouTube video, playlist or channel.</span>
    {/if}
  </div>
  {#if parsed}
    <div class="opts">
      {#if parsed.kind === 'channel'}
        <label class="chk">
          <input type="checkbox" bind:checked={isOwn} data-testid="add-source-own" /> This is my channel
        </label>
      {/if}
      <div class="seg" role="group" aria-label="Import existing comments">
        <span class="muted meta">Import existing:</span>
        {#each [['none', 'None'], ['recent', `Last ${backfill} days`], ['all', 'All']] as [m, l] (m)}
          <button
            type="button"
            class="segbtn"
            class:on={importMode === m}
            aria-pressed={importMode === m}
            onclick={() => (importMode = m as ImportMode)}
          >
            {l}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</form>

<style>
  .add {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    text-align: left;
  }
  .line {
    display: flex;
    gap: var(--s2);
  }
  .grow {
    flex: 1;
  }
  .preview {
    min-height: 20px;
    display: flex;
    gap: var(--s2);
    align-items: center;
  }
  .bad {
    color: var(--danger);
  }
  .opts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s4);
    align-items: center;
  }
  .chk {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .seg {
    display: inline-flex;
    gap: 2px;
    align-items: center;
  }
  .seg .muted {
    margin-right: 6px;
  }
  .segbtn {
    height: 24px;
    padding: 0 10px;
    border: 1px solid var(--border-strong);
    background: var(--bg-elev);
    font-size: var(--fs-label);
    cursor: pointer;
    color: var(--text-muted);
  }
  .segbtn:first-of-type {
    border-radius: var(--radius) 0 0 var(--radius);
  }
  .segbtn:last-of-type {
    border-radius: 0 var(--radius) var(--radius) 0;
  }
  .segbtn + .segbtn {
    margin-left: -1px;
  }
  .segbtn.on {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
    position: relative;
    z-index: 1;
  }
</style>
