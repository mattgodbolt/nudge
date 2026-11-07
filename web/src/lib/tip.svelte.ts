import type { Attachment } from 'svelte/attachments';
import { ariaShortcut, hotkey, keyLabels } from './keys/keymap.svelte';

export interface TipOptions {
  /** Visible tooltip text, also the accessible name unless the element already has visible text. */
  label: string;
  /** Binding id; the hotkey is looked up from the keymap so the tooltip can't drift from reality. */
  id?: string;
}

class TipState {
  target = $state<HTMLElement | null>(null);
  label = $state('');
  keys = $state<string[]>([]);
}
export const tipState = new TipState();

const SHOW_DELAY_MS = 450;
let timer: ReturnType<typeof setTimeout> | undefined;
let warm = false; // once one tooltip has shown, neighbours appear instantly
let warmTimer: ReturnType<typeof setTimeout> | undefined;

function show(el: HTMLElement, opts: TipOptions, delay: number) {
  clearTimeout(timer);
  const run = () => {
    const k = opts.id ? hotkey(opts.id) : undefined;
    tipState.label = opts.label;
    tipState.keys = k ? keyLabels(k) : [];
    tipState.target = el;
    warm = true;
    clearTimeout(warmTimer);
  };
  if (delay <= 0 || warm) run();
  else timer = setTimeout(run, delay);
}

export function hideTip(el?: HTMLElement) {
  clearTimeout(timer);
  if (el && tipState.target !== el) return;
  if (tipState.target) {
    tipState.target = null;
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => (warm = false), 300);
  }
}

/**
 * `{@attach tip({ id: 'triage.done', label: 'Done' })}`: a styled tooltip showing the label plus the
 * hotkey of the named binding; also sets aria-label and aria-keyshortcuts. Shown on hover and on
 * keyboard focus; rendered by <TipLayer> in the root so it is never clipped by overflow.
 */
export function tip(opts: TipOptions): Attachment<HTMLElement> {
  return (el) => {
    const keys = opts.id ? hotkey(opts.id) : undefined;
    el.setAttribute('aria-label', opts.label);
    const shortcut = ariaShortcut(keys);
    if (shortcut) el.setAttribute('aria-keyshortcuts', shortcut);
    else el.removeAttribute('aria-keyshortcuts');

    const enter = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') show(el, opts, SHOW_DELAY_MS);
    };
    const leave = () => hideTip(el);
    const focus = () => {
      if (el.matches(':focus-visible')) show(el, opts, 0);
    };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerdown', leave);
    el.addEventListener('click', leave);
    el.addEventListener('focus', focus);
    el.addEventListener('blur', leave);
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideTip(el);
    };
    el.addEventListener('keydown', esc);
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', leave);
      el.removeEventListener('click', leave);
      el.removeEventListener('focus', focus);
      el.removeEventListener('blur', leave);
      el.removeEventListener('keydown', esc);
      hideTip(el);
    };
  };
}
