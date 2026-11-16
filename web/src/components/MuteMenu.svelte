<script lang="ts">
  import { keymap } from '../lib/keys/keymap.svelte';
  import { feeds } from '../lib/stores/feeds.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import type { MuteKind } from '../../../shared/types';
  import Kbd from './Kbd.svelte';
  import { fade } from 'svelte/transition';
  import { tick } from 'svelte';

  interface Option {
    id: string;
    label: string;
    detail: string;
    kind: MuteKind;
    value: string | undefined;
    done: string;
  }

  const item = $derived(ui.muteFor ? inbox.items.find((i) => i.comment.id === ui.muteFor)?.item : undefined);
  const options = $derived.by((): Option[] => {
    if (!item?.github) return [];
    const out: Option[] = [];
    if (item.containerKey) {
      out.push({
        id: 'repo',
        label: `Mute ${item.containerKey}`,
        detail: 'Everything in this repository',
        kind: 'repo',
        value: item.containerKey,
        done: item.containerKey,
      });
    }
    const owner = item.containerKey?.split('/')[0];
    if (owner) {
      out.push({
        id: 'owner',
        label: `Mute all of ${owner}`,
        detail: 'Every repository of this organisation or user',
        kind: 'owner',
        value: owner,
        done: `all of ${owner}`,
      });
    }
    if (item.author) {
      out.push({
        id: 'author',
        label: `Mute ${item.author}`,
        detail: 'Everything they open',
        kind: 'author',
        value: item.author,
        done: item.author,
      });
    }
    if (item.github.authorType === 'Bot') {
      out.push({
        id: 'bots',
        label: 'Mute all bots',
        detail: 'Dependabot and friends, in every feed',
        kind: 'bots',
        value: undefined,
        done: 'all bots',
      });
    }
    out.push({
      id: 'item',
      label: 'Mute this one',
      detail: 'It will not come back for new activity',
      kind: 'item',
      value: item.id,
      done: 'this item',
    });
    return out;
  });

  let active = $state(0);
  let dialog: HTMLDivElement | undefined = $state();

  // The dialog only renders while its item is in the list. If it leaves (finished elsewhere), close the menu too:
  // otherwise its keyboard scope would outlive it and swallow every key until Escape.
  $effect(() => {
    if (ui.muteFor && !item) ui.muteFor = null;
  });

  function close() {
    ui.muteFor = null;
  }
  function choose(i: number) {
    const o = options[i];
    if (!o) return;
    close();
    void feeds.mute(o.kind, o.value, o.done);
  }

  $effect(() => {
    if (!ui.muteFor) return;
    active = 0;
    void tick().then(() => dialog?.focus());
    const unscope = keymap.pushScope('modal');
    const bind = (id: string, keys: string[], run: () => void, repeat = false) => ({
      id: `mute.menu.${id}`,
      keys,
      scope: 'modal' as const,
      group: 'App' as const,
      description: 'Mute menu',
      palette: false,
      repeat,
      run,
    });
    const unreg = keymap.register([
      bind('close', ['Escape'], close),
      bind('down', ['ArrowDown', 'j'], () => (active = Math.min(active + 1, options.length - 1)), true),
      bind('up', ['ArrowUp', 'k'], () => (active = Math.max(active - 1, 0)), true),
      bind('enter', ['Enter'], () => choose(active)),
      ...['1', '2', '3', '4', '5'].map((k, i) => bind(`n${k}`, [k], () => choose(i))),
    ]);
    return () => {
      unreg();
      unscope();
    };
  });
</script>

{#if ui.muteFor && item}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 100 }} onclick={close}>
    <div
      class="menu panel"
      data-testid="mute-menu"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Mute"
      bind:this={dialog}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="head"><strong>Mute</strong><span class="faint meta">stop seeing…</span></div>
      <div class="opts" role="listbox" aria-label="Mute">
        {#each options as o, i (o.id)}
          <button
            type="button"
            class="opt"
            class:active={active === i}
            role="option"
            aria-selected={active === i}
            data-testid="mute-{o.id}"
            onmousemove={() => (active = i)}
            onclick={() => choose(i)}
          >
            <span class="grow">
              <span class="lbl">{o.label}</span>
              <span class="faint meta det">{o.detail}</span>
            </span>
            <Kbd label={String(i + 1)} />
          </button>
        {/each}
      </div>
      <p class="faint meta note">Muted items go to All, not the inbox. Undo is offered after.</p>
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
    width: min(380px, 100%);
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
    display: flex;
    flex-direction: column;
  }
  .lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    padding: var(--s2) var(--s3);
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
