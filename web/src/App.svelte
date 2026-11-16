<script lang="ts">
  import { onMount } from 'svelte';
  import { keymap } from './lib/keys/keymap.svelte';
  import { appBindings } from './lib/keys/bindings';
  import { router } from './lib/router.svelte';
  import { connectEvents } from './lib/sse';
  import { installAutoResync } from './lib/resync.svelte';
  import { app } from './lib/stores/app.svelte';
  import { settings } from './lib/stores/settings.svelte';
  import { theme } from './lib/stores/theme.svelte';
  import Shell from './components/Shell.svelte';
  import OwnChannelBanner from './components/OwnChannelBanner.svelte';
  import { sources } from './lib/stores/sources.svelte';
  import { ui } from './lib/stores/ui.svelte';
  import Onboarding from './components/Onboarding.svelte';
  import EmptyState from './components/EmptyState.svelte';
  import InboxView from './views/InboxView.svelte';
  import SourcesView from './views/SourcesView.svelte';
  import SettingsView from './views/SettingsView.svelte';
  import StatsView from './views/StatsView.svelte';
  import RpgLayer from './components/RpgLayer.svelte';

  onMount(() => {
    theme.init();
    const detach = keymap.attach();
    const unreg = keymap.register(appBindings());
    void app.boot();
    const close = connectEvents();
    const stopAuto = installAutoResync();
    return () => {
      stopAuto();
      close();
      unreg();
      detach();
    };
  });
</script>

{#if !app.ready}
  <div class="boot" aria-busy="true"></div>
{:else if app.error && !settings.value}
  <div class="boot">
    <EmptyState title="Can't reach the Nudge server" body={app.error}>
      <button class="btn" onclick={() => void app.boot()}>Retry</button>
    </EmptyState>
  </div>
{:else}
  <RpgLayer />
  <Shell>
    {#if settings.needsKey && router.route !== 'settings'}
      <Onboarding />
    {:else}
      <!-- With no sources at all the inbox empty state asks the same question inline. -->
      {#if settings.needsOwnChannel && !ui.ownBannerDismissed && router.route !== 'settings' && sources.list.length > 0}
        <OwnChannelBanner />
      {/if}
      {#if router.route === 'sources' || router.route === 'source'}
        <SourcesView />
      {:else if router.route === 'stats'}
        <StatsView />
      {:else if router.route === 'settings'}
        <SettingsView />
      {:else}
        <InboxView />
      {/if}
    {/if}
  </Shell>
{/if}

<style>
  .boot {
    height: 100%;
    display: flex;
  }
</style>
