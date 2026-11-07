<script lang="ts">
  import { keymap, type Binding, type Group } from '../lib/keys/keymap.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import Kbd from './Kbd.svelte';
  import { fade } from 'svelte/transition';

  const ORDER: Group[] = ['Navigation', 'Triage', 'Reply', 'Go to', 'App'];

  $effect(() => {
    if (!ui.helpOpen) return;
    const close = () => (ui.helpOpen = false);
    const unscope = keymap.pushScope('help');
    const unreg = keymap.register([
      {
        id: 'help.close.esc',
        keys: ['Escape'],
        scope: 'help',
        group: 'App',
        description: 'Close help',
        palette: false,
        run: close,
      },
      {
        id: 'help.close.q',
        keys: ['?'],
        scope: 'help',
        group: 'App',
        description: 'Close help',
        palette: false,
        run: close,
      },
    ]);
    return () => {
      unreg();
      unscope();
    };
  });

  const groups = $derived.by(() => {
    if (!ui.helpOpen) return [];
    const seen = new Set<string>();
    const by = new Map<Group, Binding[]>();
    for (const b of keymap.all()) {
      if (b.scope === 'help' || b.scope === 'palette' || seen.has(b.id)) continue;
      if (b.id === 'palette.open') {
        // shown below with its key regardless of palette flag
      }
      seen.add(b.id);
      (by.get(b.group) ?? by.set(b.group, []).get(b.group)!).push(b);
    }
    return ORDER.filter((g) => by.has(g)).map((g) => ({ group: g, items: by.get(g)! }));
  });
</script>

{#if ui.helpOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 100 }} onclick={() => (ui.helpOpen = false)}>
    <div
      class="dialog panel"
      data-testid="help"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onclick={(e) => e.stopPropagation()}
    >
      <header>
        <h2>Keyboard shortcuts</h2>
        <span class="muted meta">Press <Kbd label="?" /> or <Kbd label="Esc" /> to close</span>
      </header>
      <div class="cols">
        {#each groups as g (g.group)}
          <section>
            <h3 class="label">{g.group}</h3>
            {#each g.items as b (b.id)}
              <div class="item">
                <span>{b.description}</span>
                <span class="keys">
                  {#each b.keys as k, i (k)}
                    {#if i > 0}<span class="faint">or</span>{/if}
                    <span class="combo"><Kbd keys={k} /></span>
                  {/each}
                </span>
              </div>
            {/each}
          </section>
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
    display: grid;
    place-items: center;
    z-index: 60;
    padding: var(--s4);
  }
  .dialog {
    width: min(860px, 100%);
    max-height: min(680px, 100%);
    overflow: auto;
    box-shadow: var(--shadow-pop);
    padding: var(--s4) var(--s5) var(--s5);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: var(--s4);
  }
  h2 {
    font-size: 15px;
    font-weight: 600;
  }
  .cols {
    columns: 2 320px;
    column-gap: var(--s6);
  }
  section {
    break-inside: avoid;
    margin-bottom: var(--s4);
  }
  h3 {
    margin: 0 0 var(--s1);
  }
  .item {
    display: flex;
    justify-content: space-between;
    gap: var(--s3);
    align-items: center;
    padding: 4px 0;
    font-size: var(--fs-meta);
  }
  .keys {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    flex: none;
  }
  .combo {
    display: inline-flex;
  }
</style>
