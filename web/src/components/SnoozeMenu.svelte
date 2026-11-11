<script lang="ts">
  import { keymap } from '../lib/keys/keymap.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { usage } from '../lib/usage';
  import {
    defaultCustomTime,
    formatSnoozeTime,
    fromLocalInputValue,
    snoozePresets,
    toLocalInputValue,
    type SnoozePreset,
  } from '../lib/snooze';
  import { pluralize } from '../lib/format';
  import Kbd from './Kbd.svelte';
  import { fade } from 'svelte/transition';
  import { tick } from 'svelte';

  const CUSTOM = 4; // index of "Pick date & time…"

  let presets = $state<SnoozePreset[]>([]);
  let now = $state(new Date());
  let active = $state(0);
  let custom = $state('');
  let error = $state('');
  let dialog: HTMLDivElement | undefined = $state();
  let customInput: HTMLInputElement | undefined = $state();

  function close() {
    ui.snoozeFor = null;
  }

  async function snoozeAt(at: Date, how: 'preset' | 'custom') {
    const ids = ui.snoozeFor;
    if (!ids) return;
    if (at.getTime() <= Date.now()) {
      error = 'Pick a time in the future';
      return;
    }
    usage.count(`snooze.${how}`);
    close();
    await inbox.snooze(at, ids, formatSnoozeTime(at, now));
  }

  function choose(i: number) {
    if (i === CUSTOM) {
      active = CUSTOM;
      void tick().then(() => customInput?.focus());
      return;
    }
    const p = presets[i];
    if (p) void snoozeAt(p.at, 'preset');
  }

  function confirmCustom() {
    const d = fromLocalInputValue(custom);
    if (!d) error = 'Pick a date and time';
    else void snoozeAt(d, 'custom');
  }

  function enter() {
    if (active === CUSTOM) confirmCustom();
    else choose(active);
  }

  $effect(() => {
    if (!ui.snoozeFor) return;
    // Use a local: reading `now` back after assigning it would make this effect depend on itself.
    const n = new Date();
    now = n;
    presets = snoozePresets(n);
    custom = toLocalInputValue(defaultCustomTime(n));
    active = 0;
    error = '';
    void tick().then(() => dialog?.focus());
    const unscope = keymap.pushScope('modal');
    const bind = (id: string, keys: string[], run: () => void, repeat = false) => ({
      id: `snooze.menu.${id}`,
      keys,
      scope: 'modal' as const,
      group: 'App' as const,
      description: 'Snooze menu',
      palette: false,
      repeat,
      run,
    });
    const unreg = keymap.register([
      bind('close', ['Escape'], close),
      bind('down', ['ArrowDown', 'j'], () => (active = Math.min(active + 1, CUSTOM)), true),
      bind('up', ['ArrowUp', 'k'], () => (active = Math.max(active - 1, 0)), true),
      bind('enter', ['Enter'], enter),
      ...['1', '2', '3', '4', '5'].map((k, i) => bind(`n${k}`, [k], () => choose(i))),
    ]);
    return () => {
      unreg();
      unscope();
    };
  });

  const count = $derived(ui.snoozeFor?.length ?? 0);
</script>

{#if ui.snoozeFor}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 100 }} onclick={close}>
    <div
      class="menu panel"
      data-testid="snooze-menu"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Snooze"
      bind:this={dialog}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="head">
        <strong>Snooze</strong>
        <span class="faint meta">{count > 1 ? pluralize(count, 'comment') : 'until…'}</span>
      </div>
      <div class="opts" role="listbox" aria-label="Snooze until">
        {#each presets as p, i (p.id)}
          <button
            type="button"
            class="opt"
            class:active={active === i}
            role="option"
            aria-selected={active === i}
            data-testid="snooze-{p.id}"
            onmousemove={() => (active = i)}
            onclick={() => choose(i)}
          >
            <span class="grow">{p.label}</span>
            <span class="when faint">{formatSnoozeTime(p.at, now)}</span>
            <Kbd label={String(i + 1)} />
          </button>
        {/each}
        <button
          type="button"
          class="opt"
          class:active={active === CUSTOM}
          role="option"
          aria-selected={active === CUSTOM}
          data-testid="snooze-custom"
          onmousemove={() => (active = CUSTOM)}
          onclick={() => choose(CUSTOM)}
        >
          <span class="grow">Pick date &amp; time…</span>
          <Kbd label="5" />
        </button>
        {#if active === CUSTOM}
          <div class="custom">
            <input
              bind:this={customInput}
              bind:value={custom}
              type="datetime-local"
              class="input"
              aria-label="Snooze until"
              data-testid="snooze-datetime"
              oninput={() => (error = '')}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmCustom();
                }
              }}
            />
            <button type="button" class="btn primary" data-testid="snooze-confirm" onclick={confirmCustom}
              >Snooze</button
            >
          </div>
        {/if}
      </div>
      {#if error}<p class="err meta" role="alert">{error}</p>{/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 70;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 14vh var(--s4) 0;
  }
  .menu {
    width: min(360px, 100%);
    box-shadow: var(--shadow-pop);
    padding: var(--s1);
    outline: none;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: var(--s2) var(--s3);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: var(--s3);
    width: 100%;
    padding: 8px var(--s3);
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    cursor: pointer;
    text-align: left;
  }
  .opt.active {
    background: var(--bg-hover);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .when {
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
  }
  .custom {
    display: flex;
    gap: var(--s2);
    padding: var(--s1) var(--s3) var(--s2);
  }
  .custom .input {
    flex: 1;
  }
  .err {
    padding: 0 var(--s3) var(--s2);
    color: var(--danger);
  }
  /* Phone: a bottom sheet, full width, safe-area aware, thumb-reachable. */
  @media (max-width: 899px) {
    .scrim {
      align-items: flex-end;
      padding: 0;
    }
    .menu {
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      border-bottom: 0;
      padding-bottom: env(safe-area-inset-bottom);
      animation: sheet-up 180ms var(--ease);
    }
    .opt {
      min-height: 52px;
      padding: 8px var(--s4);
      font-size: 16px;
    }
    .head {
      padding: var(--s3) var(--s4) var(--s2);
    }
    .custom {
      padding: var(--s2) var(--s4) var(--s3);
    }
    @keyframes sheet-up {
      from {
        transform: translateY(40px);
        opacity: 0;
      }
    }
  }
</style>
