<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { invoke } from '../lib/keys/keymap.svelte';
  import { tip } from '../lib/tip.svelte';
  import { usage, viaOfEvent } from '../lib/usage';
  import { decisions } from '../lib/decisions';
  import Icon from './Icon.svelte';

  type IconName = ComponentProps<typeof Icon>['name'];

  /**
   * A button for a keymap binding. With no `onclick` it runs the binding itself (identical to the hotkey);
   * pass `onclick` for actions that target something other than the cursor (e.g. a specific row).
   */
  let {
    id,
    label,
    icon,
    showLabel = true,
    disabled = false,
    onclick,
    testid,
    tabindex,
    tile = false,
    short,
    suggested = false,
    compact = false,
  }: {
    id: string;
    label: string;
    icon: IconName;
    showLabel?: boolean;
    disabled?: boolean;
    onclick?: () => void;
    testid?: string;
    /** -1 keeps many-per-page buttons (list rows) out of the tab order. */
    tabindex?: number;
    /** Phone layout: a big equal-width tile with the icon above (or beside) a short label. */
    tile?: boolean;
    /** Shorter label for tiles, where space is tight. */
    short?: string;
    /** The current suggestion points here: a quiet ring, never an action of its own. */
    suggested?: boolean;
    /** Show `short` instead of the full label on a (non-tile) button, when the toolbar is middling wide. */
    compact?: boolean;
  } = $props();

  function click(e: MouseEvent) {
    e.stopPropagation(); // never let a button click select/open the row beneath it
    // The one place every button for a keymap binding goes through, whichever row or bar it sits in.
    const via = tile ? 'touch' : viaOfEvent(e);
    usage.binding(id, via);
    decisions.noteInput(via);
    if (onclick) onclick();
    else invoke(id);
    // A pointer click must not leave focus parked on the button; keyboard activation keeps it.
    if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
  }
</script>

<button
  type="button"
  class="btn sm ghost action"
  class:icon={!showLabel && !tile}
  class:tile
  class:suggested
  data-suggested={suggested ? 'true' : undefined}
  {disabled}
  {tabindex}
  onclick={click}
  data-testid={testid}
  {@attach tip({ id, label })}
>
  <Icon name={icon} size={tile ? 22 : 14} />
  {#if tile}<span class="lbl">{short ?? label}</span>{:else if showLabel}<span class="lbl"
      >{compact ? (short ?? label) : label}</span
    >{/if}
</button>

<style>
  .action {
    gap: 5px;
  }
  .action.icon {
    width: 24px;
    padding: 0;
    justify-content: center;
  }
  .action.tile {
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    min-height: 60px;
    padding: 6px 4px;
    border: 1px solid var(--border-strong);
    background: var(--bg-elev);
    color: var(--text);
    font-size: var(--fs-label);
    white-space: normal;
    text-align: center;
  }
  .action.tile:active:not(:disabled) {
    background: var(--bg-hover);
  }
  /* The suggested action: an accent ring and a faint wash, quiet enough to ignore and clear enough to follow. */
  .action.suggested {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
    background: var(--accent-soft);
    color: var(--text);
  }
  .action.suggested.tile {
    border-color: var(--accent);
  }
  .action:focus-visible {
    box-shadow: var(--focus-ring);
    outline: none;
  }
</style>
