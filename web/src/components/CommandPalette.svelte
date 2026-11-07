<script lang="ts">
  import { keymap, keyLabels } from '../lib/keys/keymap.svelte';
  import { router } from '../lib/router.svelte';
  import { fuzzyFilter } from '../lib/fuzzy';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { labels } from '../lib/stores/labels.svelte';
  import { sources } from '../lib/stores/sources.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { fade } from 'svelte/transition';
  import { tick } from 'svelte';

  interface Entry {
    id: string;
    label: string;
    hint?: string;
    group: string;
    run: () => void;
  }

  let query = $state('');
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (!ui.paletteOpen) return;
    query = '';
    active = 0;
    void tick().then(() => input?.focus());
    const unscope = keymap.pushScope('palette');
    const unreg = keymap.register({
      id: 'palette.close',
      keys: ['Escape'],
      scope: 'palette',
      group: 'App',
      description: 'Close palette',
      palette: false,
      run: () => (ui.paletteOpen = false),
    });
    return () => {
      unreg();
      unscope();
    };
  });

  const entries = $derived.by<Entry[]>(() => {
    if (!ui.paletteOpen) return [];
    const out: Entry[] = [];
    for (const b of keymap.all()) {
      if (b.palette === false || b.scope === 'palette' || b.scope === 'help' || b.scope === 'composer') continue;
      if (b.when && !b.when()) continue;
      out.push({
        id: b.id,
        label: b.description,
        hint: b.keys[0] ? keyLabels(b.keys[0]).join(' ') : undefined,
        group: b.group,
        run: () => b.run(),
      });
    }
    out.push({
      id: 'sources.add',
      label: 'Add source…',
      group: 'Go to',
      run: () => {
        router.navigate('sources');
        ui.addSourceFocusTick++;
      },
    });
    for (const s of sources.list) {
      out.push({
        id: `src.${s.id}`,
        label: `Go to source: ${s.title ?? s.ytId}`,
        group: 'Go to',
        run: () => router.navigate('inbox', { source: String(s.id) }),
      });
    }
    for (const l of labels.list) {
      out.push({
        id: `lbl.${l.id}`,
        label: `Go to label: ${l.name}`,
        group: 'Go to',
        run: () => router.navigate('label', {}, { id: l.id }),
      });
    }
    const seenVideos = new Set<string>();
    for (const i of inbox.items) {
      if (seenVideos.has(i.video.id) || seenVideos.size >= 40) continue;
      seenVideos.add(i.video.id);
      out.push({
        id: `vid.${i.video.id}`,
        label: `Filter by video: ${i.video.title}`,
        group: 'Go to',
        run: () => router.setQuery({ video: i.video.id, c: undefined }, { replace: false }),
      });
    }
    return out;
  });

  const results = $derived(fuzzyFilter(entries, query, (e) => e.label).slice(0, 50));
  $effect(() => {
    void results;
    active = 0;
  });

  function exec(e: Entry | undefined) {
    if (!e) return;
    ui.paletteOpen = false;
    // Let the palette scope unwind before running, so scoped bindings behave as normal.
    queueMicrotask(() => setTimeout(e.run, 0));
  }

  function onkey(ev: KeyboardEvent) {
    if (ev.key === 'ArrowDown' || (ev.ctrlKey && ev.key === 'n')) {
      active = Math.min(active + 1, results.length - 1);
    } else if (ev.key === 'ArrowUp' || (ev.ctrlKey && ev.key === 'p')) {
      active = Math.max(active - 1, 0);
    } else if (ev.key === 'Enter') {
      exec(results[active]);
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  }

  $effect(() => {
    document.querySelector(`[data-pal-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  });
</script>

{#if ui.paletteOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 100 }} onclick={() => (ui.paletteOpen = false)}>
    <div
      class="palette panel"
      data-testid="palette"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Command palette"
      onclick={(e) => e.stopPropagation()}
    >
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onkey}
        class="q"
        placeholder="Type a command…"
        aria-label="Command"
        role="combobox"
        aria-expanded="true"
        aria-controls="pal-list"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="list" id="pal-list" role="listbox">
        {#each results as e, i (e.id)}
          <button
            class="opt"
            class:active={i === active}
            data-pal-index={i}
            role="option"
            aria-selected={i === active}
            onmousemove={() => (active = i)}
            onclick={() => exec(e)}
          >
            <span class="truncate">{e.label}</span>
            {#if e.hint}<span class="hint mono">{e.hint}</span>{/if}
          </button>
        {:else}
          <div class="none muted">No matching commands</div>
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
  .palette {
    width: min(560px, 100%);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }
  .q {
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    padding: 14px var(--s4);
    font-size: 15px;
    outline: none;
  }
  .list {
    max-height: 340px;
    overflow-y: auto;
    padding: var(--s1);
  }
  .opt {
    display: flex;
    width: 100%;
    justify-content: space-between;
    align-items: center;
    gap: var(--s3);
    padding: 7px var(--s3);
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
  .hint {
    color: var(--text-faint);
    font-size: 12px;
    flex: none;
  }
  .none {
    padding: var(--s4);
    text-align: center;
    font-size: var(--fs-meta);
  }
  @media (max-width: 899px) {
    .scrim {
      padding: calc(env(safe-area-inset-top) + 8px) var(--s2) 0;
    }
    .q {
      min-height: 56px;
      font-size: 16px;
    }
    .list {
      max-height: 60vh;
    }
    .opt {
      min-height: 52px;
      padding: 8px var(--s3);
    }
  }
</style>
