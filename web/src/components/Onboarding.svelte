<script lang="ts">
  import { settings } from '../lib/stores/settings.svelte';
  import { api } from '../lib/api';
  import { toasts } from '../lib/stores/toasts.svelte';
  import { router } from '../lib/router.svelte';

  let key = $state('');
  let busy = $state(false);

  /** GitHub feeds and todos need no YouTube key: let the owner past this card, to the page that adds a feed. */
  function skip() {
    settings.skipYoutube();
    router.navigate('sources');
  }

  async function save(e: Event) {
    e.preventDefault();
    if (!key.trim()) return;
    busy = true;
    try {
      const test = await api.testKey(key.trim());
      if (!test.ok) {
        toasts.error(test.message || 'That key was rejected by YouTube');
        return;
      }
      if (await settings.save({ apiKey: key.trim() })) key = '';
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : 'Could not verify the key');
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap" data-testid="onboarding">
  <form class="card panel" onsubmit={save}>
    <h1>Welcome to Nudge</h1>
    <p class="muted">
      A local, keyboard-driven inbox for your YouTube comments. To start, add a YouTube Data API v3 key.
    </p>
    <label class="label" for="key">API key</label>
    <input id="key" class="input mono" type="password" bind:value={key} placeholder="AIza…" autocomplete="off" />
    <button class="btn primary" type="submit" disabled={!key.trim() || busy}
      >{busy ? 'Checking…' : 'Verify and save'}</button
    >
    <button class="btn" type="button" onclick={skip} data-testid="onboarding-skip"
      >I only use GitHub or todos: skip this</button
    >
    <p class="meta faint">
      You can also set the <code>YOUTUBE_API_KEY</code> environment variable instead. It never leaves this machine except
      in requests to YouTube.
    </p>
  </form>
</div>

<style>
  .wrap {
    flex: 1;
    display: grid;
    place-items: center;
    padding: var(--s4);
    overflow: auto;
  }
  .card {
    width: min(440px, 100%);
    padding: var(--s5);
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
</style>
