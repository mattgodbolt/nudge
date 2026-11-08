<script lang="ts">
  import type { Snippet } from 'svelte';
  import { keymap } from '../lib/keys/keymap.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import { sync } from '../lib/stores/sync.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { router } from '../lib/router.svelte';
  import { until } from '../lib/format';
  import Sidebar from './Sidebar.svelte';
  import Toasts from './Toasts.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import HelpOverlay from './HelpOverlay.svelte';
  import SnoozeMenu from './SnoozeMenu.svelte';
  import MuteMenu from './MuteMenu.svelte';
  import Assistant from './Assistant.svelte';
  import { assistant } from '../lib/stores/assistant.svelte';
  import LabelPicker from './LabelPicker.svelte';
  import Icon from './Icon.svelte';
  import TipLayer from './TipLayer.svelte';
  import Kbd from './Kbd.svelte';

  let { children }: { children: Snippet } = $props();
  // On narrow screens the sidebar collapses to a top nav unless we're in a sub-pane.
  const hideNavOnMobile = $derived(
    ui.pane === 'thread' && ['inbox', 'done', 'all', 'snoozed', 'label'].includes(router.route),
  );
</script>

<div class="shell" class:collapsed={ui.sidebarCollapsed} class:hide-nav={hideNavOnMobile}>
  <div class="side"><Sidebar /></div>
  <main>
    {#if ui.sidebarCollapsed}
      <button
        class="btn ghost sm reopen"
        onclick={() => ui.toggleSidebar()}
        title="Show sidebar ([)"
        aria-label="Show sidebar"
      >
        <Icon name="sidebar" size={15} />
      </button>
    {/if}
    {#if settings.value?.demo}
      <div class="banner demo">
        <span class="badge accent">DEMO</span> Fake data from a simulated YouTube. Nothing is sent anywhere.
      </div>
    {/if}
    {#if sync.blocked}
      <div class="banner warn" data-testid="quota-banner">
        <Icon name="alert" size={14} /> YouTube quota exhausted. Sync is paused and resumes {until(
          sync.quota?.blockedUntil,
          sync.now,
        )}.
      </div>
    {/if}
    <div class="content">{@render children()}</div>
  </main>
</div>

<Toasts />
<CommandPalette />
<HelpOverlay />
<SnoozeMenu />
<MuteMenu />
<Assistant />
{#if !assistant.open && !hideNavOnMobile}
  <button
    type="button"
    class="fab"
    data-testid="assistant-fab"
    aria-label="Tell Nudge"
    onclick={() => assistant.show()}
  >
    <Icon name="mic" size={26} />
  </button>
{/if}
<LabelPicker />
<TipLayer />
{#if keymap.pendingChord}
  <div class="chord" aria-live="polite"><Kbd label={keymap.pendingChord} /> <span class="muted">…</span></div>
{/if}

<style>
  .shell {
    display: flex;
    height: 100%;
  }
  .side {
    display: contents;
  }
  .collapsed .side {
    display: none;
  }
  main {
    flex: 1;
    min-width: 0;
    /* In the phone's column layout the default min-height:auto lets main grow to its content, so pages never scroll. */
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .reopen {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 5;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: 6px var(--s4);
    font-size: var(--fs-meta);
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    background: var(--bg-sunken);
  }
  .banner.warn {
    background: color-mix(in srgb, var(--warn) 12%, var(--bg));
    color: var(--text);
  }
  /* Phone only: the one-press way in. Desktop uses `c` and the sidebar button. */
  .fab {
    display: none;
  }
  .chord {
    position: fixed;
    right: var(--s4);
    bottom: var(--s4);
    padding: 6px 10px;
    border-radius: var(--radius);
    background: var(--bg-elev);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-pop);
    z-index: 90;
    font-size: var(--fs-meta);
  }
  @media (max-width: 899px) {
    .fab {
      display: flex;
      align-items: center;
      justify-content: center;
      position: fixed;
      right: var(--s4);
      bottom: calc(var(--s4) + env(safe-area-inset-bottom));
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: 0;
      background: var(--accent);
      color: var(--on-accent, #fff);
      box-shadow: var(--shadow-pop);
      z-index: 60;
      cursor: pointer;
    }
    .shell {
      flex-direction: column;
    }
    .side {
      display: block;
    }
    .hide-nav .side {
      display: none;
    }
    .collapsed .side {
      display: block;
    }
    .reopen {
      display: none;
    }
  }
</style>
