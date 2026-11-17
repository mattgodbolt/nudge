<script lang="ts">
  import type { ImportMode } from '../../../shared/types';
  import { settings } from '../lib/stores/settings.svelte';
  import { sources } from '../lib/stores/sources.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';

  let {
    placeholder = 'https://www.youtube.com/@yourchannel or @yourchannel',
    importMode,
    onadded,
  }: { placeholder?: string; importMode?: ImportMode; onadded?: () => void } = $props();

  let value = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(e: Event) {
    e.preventDefault();
    const input = value.trim();
    if (!input || busy) return;
    busy = true;
    error = '';
    const err = await settings.addOwnChannel(input, importMode);
    busy = false;
    if (err) {
      error = err;
      return;
    }
    value = '';
    void sources.load().catch(() => {});
    toasts.success('Channel added as yours', 3000);
    onadded?.();
  }
</script>

<form class="own" onsubmit={submit} data-testid="own-channel-form">
  <div class="line">
    <input
      class="input grow"
      {placeholder}
      bind:value
      aria-label="Your channel URL or @handle"
      spellcheck="false"
      autocomplete="off"
      data-testid="own-channel-input"
    />
    <button class="btn primary" type="submit" disabled={!value.trim() || busy}>{busy ? 'Finding…' : 'Add'}</button>
  </div>
  {#if error}<p class="bad meta" role="alert">{error}</p>{/if}
</form>

<style>
  .own {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    text-align: left;
    width: 100%;
  }
  .line {
    display: flex;
    gap: var(--s2);
  }
  .grow {
    flex: 1;
  }
  .bad {
    color: var(--danger);
  }
</style>
