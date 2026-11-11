<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { invoke } from '../lib/keys/keymap.svelte';
  import { tip } from '../lib/tip.svelte';
  import { usage, viaOfEvent } from '../lib/usage';
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
  } = $props();

  function click(e: MouseEvent) {
    e.stopPropagation(); // never let a button click select/open the row beneath it
    // The one place every button for a keymap binding goes through, whichever row or bar it sits in.
    usage.binding(id, tile ? 'touch' : viaOfEvent(e));
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
  {disabled}
  {tabindex}
  onclick={click}
  data-testid={testid}
  {@attach tip({ id, label })}
>
  <Icon name={icon} size={tile ? 22 : 14} />
  {#if tile}<span class="lbl">{short ?? label}</span>{:else if showLabel}<span class="lbl">{label}</span>{/if}
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
  .action:focus-visible {
    box-shadow: var(--focus-ring);
    outline: none;
  }
</style>
