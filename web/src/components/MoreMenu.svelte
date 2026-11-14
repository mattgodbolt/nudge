<script lang="ts">
  import { keymap, hotkeyLabel } from '../lib/keys/keymap.svelte';
  import { suggestedButton } from '../lib/itemState';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { decisions } from '../lib/decisions';
  import { usage } from '../lib/usage';
  import Icon from './Icon.svelte';
  import Kbd from './Kbd.svelte';
  import { fade } from 'svelte/transition';
  import { tick } from 'svelte';
  import type { ComponentProps } from 'svelte';

  /**
   * The rest of a phone row's actions. A row has room for four big tiles, so Done, No action and Snooze get them and
   * what is left (Mark replied, Label, Mute) lives behind the fourth, as a bottom sheet like the snooze and mute ones.
   */
  interface Option {
    id: string;
    binding: string;
    label: string;
    icon: ComponentProps<typeof Icon>['name'];
    run: () => void;
  }

  const row = $derived(ui.moreFor ? inbox.items.find((i) => i.comment.id === ui.moreFor) : undefined);
  const suggested = $derived(row ? suggestedButton(row, 'row') : null);
  const options = $derived.by((): Option[] => {
    if (!row) return [];
    const id = row.comment.id;
    const out: Option[] = [];
    if (row.comment.state === 'inbox') {
      out.push({
        id: 'replied',
        binding: 'triage.replied',
        label: 'Mark replied',
        icon: 'check-all',
        run: () => void inbox.triage('replied', [id]),
      });
    }
    out.push({ id: 'label', binding: 'label.open', label: 'Label…', icon: 'tag', run: () => ui.openLabelPicker([id]) });
    if (row.item.provider === 'github') {
      out.push({ id: 'mute', binding: 'mute.open', label: 'Mute…', icon: 'x', run: () => ui.openMute(id) });
    }
    return out;
  });

  let active = $state(0);
  let dialog: HTMLDivElement | undefined = $state();

  function close() {
    ui.moreFor = null;
  }
  function choose(i: number) {
    const o = options[i];
    if (!o) return;
    close();
    usage.binding(o.binding, 'touch');
    decisions.noteInput('touch');
    o.run();
  }

  $effect(() => {
    if (!ui.moreFor) return;
    active = 0;
    void tick().then(() => dialog?.focus());
    const unscope = keymap.pushScope('modal');
    const bind = (id: string, keys: string[], run: () => void, repeat = false) => ({
      id: `more.menu.${id}`,
      keys,
      scope: 'modal' as const,
      group: 'App' as const,
      description: 'More actions menu',
      palette: false,
      repeat,
      run,
    });
    const unreg = keymap.register([
      bind('close', ['Escape'], close),
      bind('down', ['ArrowDown', 'j'], () => (active = Math.min(active + 1, options.length - 1)), true),
      bind('up', ['ArrowUp', 'k'], () => (active = Math.max(active - 1, 0)), true),
      bind('enter', ['Enter'], () => choose(active)),
      ...['1', '2', '3'].map((k, i) => bind(`n${k}`, [k], () => choose(i))),
    ]);
    return () => {
      unreg();
      unscope();
    };
  });
</script>

{#if ui.moreFor && row}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 100 }} onclick={close}>
    <div
      class="menu panel"
      data-testid="more-menu"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="More actions"
      bind:this={dialog}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="opts" role="menu" aria-label="More actions">
        {#each options as o, i (o.id)}
          <button
            type="button"
            class="opt"
            class:active={active === i}
            role="menuitem"
            data-testid="more-{o.id}"
            onmousemove={() => (active = i)}
            onclick={() => choose(i)}
          >
            <Icon name={o.icon} size={18} />
            <span class="grow">{o.label}</span>
            {#if suggested === o.binding}<span class="faint meta">Suggested</span>{/if}
            {#each hotkeyLabel(o.binding) as k (k)}<Kbd label={k} />{/each}
          </button>
        {/each}
      </div>
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
    width: min(340px, 100%);
    box-shadow: var(--shadow-pop);
    padding: var(--s1);
    outline: none;
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
  @media (max-width: 899px) {
    .scrim {
      align-items: flex-end;
      padding: 0;
    }
    .menu {
      width: 100%;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      border-bottom: 0;
      padding-bottom: env(safe-area-inset-bottom);
    }
    .opt {
      min-height: 56px;
      padding: 8px var(--s4);
      font-size: 16px;
    }
  }
</style>
