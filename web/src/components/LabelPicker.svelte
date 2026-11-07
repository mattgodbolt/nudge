<script lang="ts">
  import { keymap } from '../lib/keys/keymap.svelte';
  import { router } from '../lib/router.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { labels, labelColorVar } from '../lib/stores/labels.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { formatNumber } from '../lib/format';
  import { MAX_LABEL_NAME, type LabelColor } from '../../../shared/types';
  import { fade } from 'svelte/transition';
  import { tick } from 'svelte';

  type Row =
    | { kind: 'label'; id: number; name: string; color: LabelColor; state: 'on' | 'off' | 'mixed'; count: number }
    | { kind: 'create'; name: string };

  const picker = $derived(ui.labelPicker);
  const goto = $derived(picker?.mode === 'goto');
  let filter = $state('');
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let busy = false;

  function close() {
    ui.labelPicker = null;
  }

  $effect(() => {
    if (!ui.labelPicker) return;
    filter = '';
    active = 0;
    void tick().then(() => input?.focus());
    const unscope = keymap.pushScope('modal');
    const unreg = keymap.register({
      id: 'label.picker.close',
      keys: ['Escape'],
      scope: 'modal',
      group: 'App',
      description: 'Close label picker',
      palette: false,
      run: close,
    });
    return () => {
      unreg();
      unscope();
    };
  });

  /** Per-label state across the target comments. Reads the live items so toggles reflect immediately. */
  const rows = $derived.by<Row[]>(() => {
    const p = picker;
    if (!p) return [];
    const q = filter.trim().toLowerCase();
    const targets =
      p.mode === 'apply' ? inbox.items.filter((i) => p.ids.includes(i.comment.id)) : ([] as typeof inbox.items);
    const out: Row[] = [];
    for (const l of labels.list) {
      if (q && !l.name.toLowerCase().includes(q)) continue;
      const n = targets.filter((t) => t.labels.includes(l.id)).length;
      out.push({
        kind: 'label',
        id: l.id,
        name: l.name,
        color: l.color,
        state: n === 0 ? 'off' : n === targets.length ? 'on' : 'mixed',
        count: inbox.counts.byLabel[l.id] ?? 0,
      });
    }
    const name = filter.trim();
    if (p.mode === 'apply' && name && !labels.list.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      out.push({ kind: 'create', name });
    }
    return out;
  });

  $effect(() => {
    active = Math.min(active, Math.max(rows.length - 1, 0));
  });
  $effect(() => {
    document.querySelector(`[data-label-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  async function activate(row: Row | undefined) {
    const p = picker;
    if (!row || !p || busy) return;
    if (p.mode === 'goto') {
      if (row.kind !== 'label') return;
      close();
      ui.pane = 'list';
      router.navigate('label', {}, { id: row.id });
      return;
    }
    busy = true;
    try {
      if (row.kind === 'create') {
        const created = await labels.create(row.name.slice(0, MAX_LABEL_NAME));
        if (!created) return;
        filter = '';
        await inbox.applyLabels([created.id], [], p.ids);
      } else {
        await inbox.applyLabels(row.state === 'on' ? [] : [row.id], row.state === 'on' ? [row.id] : [], p.ids);
      }
    } finally {
      busy = false;
    }
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) active = Math.min(active + 1, rows.length - 1);
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) active = Math.max(active - 1, 0);
    else if (e.key === 'Enter') void activate(rows[active]);
    // Space toggles, but only while the filter is empty: afterwards it is part of a label name.
    else if (e.key === ' ' && !filter && !goto) void activate(rows[active]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const count = $derived(picker?.mode === 'apply' ? picker.ids.length : 0);
</script>

{#if picker}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 100 }} onclick={close}>
    <div
      class="picker panel"
      data-testid="label-picker"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label={goto ? 'Go to label' : 'Label as'}
      onclick={(e) => e.stopPropagation()}
    >
      <input
        bind:this={input}
        bind:value={filter}
        onkeydown={onkey}
        class="q"
        maxlength={MAX_LABEL_NAME}
        placeholder={goto ? 'Go to label…' : count > 1 ? `Label ${count} comments…` : 'Label as…'}
        aria-label={goto ? 'Filter labels' : 'Filter or create label'}
        role="combobox"
        aria-expanded="true"
        aria-controls="label-list"
        autocomplete="off"
        spellcheck="false"
        data-testid="label-filter"
      />
      <div class="list" id="label-list" role="listbox" aria-multiselectable={!goto}>
        {#each rows as r, i (r.kind === 'label' ? r.id : 'create')}
          <button
            type="button"
            class="opt"
            class:active={i === active}
            data-label-index={i}
            data-testid={r.kind === 'label' ? 'label-option' : 'label-create'}
            role="option"
            aria-selected={r.kind === 'label' && r.state !== 'off'}
            aria-checked={r.kind === 'label' ? (r.state === 'mixed' ? 'mixed' : r.state === 'on') : undefined}
            onmousemove={() => (active = i)}
            onclick={() => void activate(r)}
          >
            {#if r.kind === 'create'}
              <span class="check plus">+</span>
              <span class="truncate">Create “{r.name}”</span>
            {:else}
              {#if !goto}
                <span class="check" class:on={r.state !== 'off'} aria-hidden="true"
                  >{r.state === 'on' ? '✓' : r.state === 'mixed' ? '–' : ''}</span
                >
              {/if}
              <i class="dot" style:background={labelColorVar(r.color)}></i>
              <span class="truncate grow">{r.name}</span>
              {#if goto && r.count > 0}<span class="faint meta">{formatNumber(r.count)}</span>{/if}
            {/if}
          </button>
        {:else}
          <div class="none muted">
            {goto ? 'No labels yet. Press l on a comment to create one.' : 'Type a name to create a label'}
          </div>
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
  .picker {
    width: min(360px, 100%);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }
  .q {
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    padding: 12px var(--s4);
    font-size: 15px;
    outline: none;
  }
  .list {
    max-height: 320px;
    overflow-y: auto;
    padding: var(--s1);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: var(--s2);
    width: 100%;
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
  .grow {
    flex: 1;
    min-width: 0;
  }
  .check {
    width: 16px;
    height: 16px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-size: 12px;
    line-height: 1;
    background: var(--bg);
  }
  .check.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
  .check.plus {
    border-style: dashed;
    color: var(--text-muted);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
  }
  .none {
    padding: var(--s4);
    text-align: center;
    font-size: var(--fs-meta);
  }
  /* Phone: a bottom sheet, full width, safe-area aware, thumb-reachable. */
  @media (max-width: 899px) {
    .scrim {
      align-items: flex-end;
      padding: 0;
    }
    .picker {
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
    .q {
      min-height: 56px;
      font-size: 16px;
      padding: 0 var(--s4);
    }
    .list {
      max-height: calc(80vh - 56px);
    }
    .q:focus-visible {
      box-shadow: none;
    }
    .check {
      width: 24px;
      height: 24px;
    }
    @keyframes sheet-up {
      from {
        transform: translateY(40px);
        opacity: 0;
      }
    }
  }
</style>
