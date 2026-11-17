import { tick } from 'svelte';
import { keymap } from './keymap.svelte';

export interface ModalBinding {
  /** Appended to the scope id: `{id: 'mute.menu'}` + `'close'` registers `mute.menu.close`. */
  id: string;
  keys: string[];
  run: () => void;
  /** Allow auto-repeat (holding the key), for list navigation. */
  repeat?: boolean;
}

export interface ModalScopeOptions {
  /** Prefix for the binding ids. */
  id: string;
  /** Shown in the keymap for every binding. */
  description: string;
  /** Element to focus once the dialog has rendered (the dialog itself, or its input). */
  focus: () => HTMLElement | undefined;
  bindings: ModalBinding[];
}

/**
 * Makes a modal overlay own the keyboard: pushes the exclusive 'modal' scope, focuses the dialog and registers its
 * bindings (none of them in the palette). Call it from an `$effect` and return the result, so closing the modal pops the
 * scope again; otherwise the scope would outlive the dialog and swallow every key.
 */
export function modalScope({ id, description, focus, bindings }: ModalScopeOptions): () => void {
  void tick().then(() => focus()?.focus());
  const unscope = keymap.pushScope('modal');
  const unreg = keymap.register(
    bindings.map((b) => ({
      id: `${id}.${b.id}`,
      keys: b.keys,
      scope: 'modal' as const,
      group: 'App' as const,
      description,
      palette: false,
      repeat: b.repeat ?? false,
      run: b.run,
    })),
  );
  return () => {
    unreg();
    unscope();
  };
}
