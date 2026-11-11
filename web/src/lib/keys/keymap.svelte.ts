import { untrack } from 'svelte';
import { usage } from '../usage';

export type Scope = 'global' | 'list' | 'thread' | 'composer' | 'palette' | 'help' | 'modal';
export type Group = 'Navigation' | 'Triage' | 'Reply' | 'Go to' | 'App';

export interface Binding {
  id: string;
  /** e.g. ['j', 'ArrowDown'], ['g i'], ['$mod+k']. Space separates chord steps. */
  keys: string[];
  scope: Scope;
  group: Group;
  description: string;
  when?: () => boolean;
  run: (e?: KeyboardEvent) => void;
  /** Show in the command palette (default true). */
  palette?: boolean;
  /** Allow auto-repeat (holding the key). Off by default so held triage/reply/undo keys fire once. */
  repeat?: boolean;
  /** Fires even when a lower-than-exclusive scope would normally swallow it. */
  global?: boolean;
}

/** Scopes that block everything beneath them (except `global: true` bindings). */
const EXCLUSIVE: ReadonlySet<Scope> = new Set(['palette', 'help', 'modal', 'composer']);
const CHORD_TIMEOUT_MS = 1000;

interface Step {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function parseStep(str: string): Step {
  const tokens = str.length > 1 && str.endsWith('+') ? [...str.slice(0, -2).split('+'), '+'] : str.split('+');
  const key = tokens[tokens.length - 1] ?? '';
  const mods = new Set(tokens.slice(0, -1).map((t) => t.toLowerCase()));
  return {
    mod: mods.has('$mod'),
    ctrl: mods.has('ctrl'),
    meta: mods.has('meta'),
    alt: mods.has('alt'),
    shift: mods.has('shift'),
    key,
  };
}

export function parseKeys(keys: string): Step[] {
  return keys.trim().split(/\s+/).map(parseStep);
}

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file'].includes(type);
  }
  return false;
}

/** Focused controls that own Enter/Space: a global Enter binding must not hijack their activation. */
function activatesOnEnter(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'BUTTON' || t.tagName === 'A' || t.getAttribute('role') === 'button';
}

export class Keymap {
  /** Overridable for tests. */
  isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

  #bindings = $state.raw<Binding[]>([]);
  #scopes = $state.raw<{ scope: Scope; token: symbol }[]>([{ scope: 'global', token: Symbol('base') }]);
  #buffer: KeyboardEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #parsed = new WeakMap<Binding, Step[][]>();
  pendingChord = $state<string | null>(null);

  get activeScopes(): Scope[] {
    return this.#scopes.map((s) => s.scope);
  }

  register(b: Binding | Binding[]): () => void {
    const list = Array.isArray(b) ? b : [b];
    const ids = new Set(list.map((x) => x.id));
    untrack(() => (this.#bindings = [...this.#bindings.filter((x) => !ids.has(x.id)), ...list]));
    return () => untrack(() => (this.#bindings = this.#bindings.filter((x) => !list.includes(x))));
  }

  pushScope(scope: Scope): () => void {
    const token = Symbol(scope);
    untrack(() => (this.#scopes = [...this.#scopes, { scope, token }]));
    return () => untrack(() => (this.#scopes = this.#scopes.filter((s) => s.token !== token)));
  }

  all(): Binding[] {
    return this.#bindings;
  }

  byId(id: string): Binding | undefined {
    return this.#bindings.find((b) => b.id === id);
  }

  /** Bindings eligible right now, highest priority first. */
  #candidates(): Binding[] {
    const out: Binding[] = [];
    let blocked = false;
    for (let i = this.#scopes.length - 1; i >= 0; i--) {
      const scope = this.#scopes[i]!.scope;
      for (const b of this.#bindings) {
        if (b.scope !== scope) continue;
        if (blocked && !b.global) continue;
        if (b.when && !b.when()) continue;
        out.push(b);
      }
      if (EXCLUSIVE.has(scope)) blocked = true;
    }
    return out;
  }

  #stepMatches(s: Step, e: KeyboardEvent): boolean {
    const wantMeta = s.meta || (s.mod && this.isMac);
    const wantCtrl = s.ctrl || (s.mod && !this.isMac);
    if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== s.alt) return false;
    const hasCmd = wantMeta || wantCtrl;
    if (s.key.length === 1) {
      if (hasCmd || s.shift) {
        // Letters are matched case-insensitively and shift is explicit.
        if (e.shiftKey !== s.shift) return false;
        return e.key.toLowerCase() === s.key.toLowerCase();
      }
      // Plain characters: case/shift is carried by e.key itself ("J", "?").
      return e.key === s.key;
    }
    return e.shiftKey === s.shift && e.key === s.key;
  }

  #setPending(buf: KeyboardEvent[]) {
    this.#buffer = buf;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (buf.length === 0) {
      this.pendingChord = null;
      return;
    }
    this.pendingChord = buf.map((e) => e.key).join(' ');
    this.#timer = setTimeout(() => this.#setPending([]), CHORD_TIMEOUT_MS);
  }

  #sequences(b: Binding): Step[][] {
    let p = this.#parsed.get(b);
    if (!p) {
      p = b.keys.map(parseKeys);
      this.#parsed.set(b, p);
    }
    return p;
  }

  /** Returns true if the event was consumed. Exposed for tests; the window listener calls it. */
  handle(e: KeyboardEvent): boolean {
    if (e.isComposing) return false;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return false;

    const editable = isEditable(e.target);
    const hasCmd = e.metaKey || e.ctrlKey;
    if (editable && !hasCmd && e.key !== 'Escape') return false;
    if ((e.key === 'Enter' || e.key === ' ') && !hasCmd && activatesOnEnter(e.target)) return false;

    const seq = [...this.#buffer, e];
    let partial = false;
    let hit: Binding | null = null;
    for (const b of this.#candidates()) {
      for (const steps of this.#sequences(b)) {
        if (steps.length < seq.length) continue;
        if (!seq.every((ev, i) => this.#stepMatches(steps[i]!, ev))) continue;
        if (steps.length === seq.length) {
          hit = b;
          break;
        }
        partial = true;
      }
      if (hit) break;
    }

    if (hit) {
      this.#setPending([]);
      if (e.repeat && !hit.repeat) {
        // Swallow auto-repeat so holding e/d/r/z can't triage the whole list.
        e.preventDefault();
        return true;
      }
      e.preventDefault();
      usage.binding(hit.id, 'kbd');
      hit.run(e);
      return true;
    }
    if (partial) {
      e.preventDefault();
      this.#setPending(seq);
      return true;
    }
    if (this.#buffer.length > 0) {
      // Broken chord: forget it and treat this key as a fresh start (Escape just cancels).
      this.#setPending([]);
      return e.key === 'Escape' ? true : this.handle(e);
    }
    return false;
  }

  attach(target: Window = window): () => void {
    const fn = (e: KeyboardEvent) => void this.handle(e);
    target.addEventListener('keydown', fn);
    return () => target.removeEventListener('keydown', fn);
  }

  /** Test helper. */
  reset() {
    this.#bindings = [];
    this.#scopes = [this.#scopes[0]!];
    this.#setPending([]);
  }
}

export const keymap = new Keymap();

/** Human-friendly label tokens for a key string, e.g. '$mod+Enter' -> ['⌘', '↵']. */
export function keyLabels(keys: string, isMac = keymap.isMac): string[] {
  const names: Record<string, string> = {
    Enter: '↵',
    Escape: 'Esc',
    ArrowDown: '↓',
    ArrowUp: '↑',
    ArrowLeft: '←',
    ArrowRight: '→',
    ' ': 'Space',
  };
  const out: string[] = [];
  for (const step of keys.trim().split(/\s+/)) {
    const s = parseStep(step);
    const parts: string[] = [];
    if (s.mod) parts.push(isMac ? '⌘' : 'Ctrl');
    if (s.ctrl) parts.push(isMac ? '⌃' : 'Ctrl');
    if (s.meta) parts.push(isMac ? '⌘' : 'Meta');
    if (s.alt) parts.push(isMac ? '⌥' : 'Alt');
    if (s.shift) parts.push(isMac ? '⇧' : 'Shift');
    parts.push(names[s.key] ?? (s.key.length === 1 && parts.length > 0 ? s.key.toUpperCase() : s.key));
    out.push(isMac ? parts.join('') : parts.join('+'));
  }
  return out;
}

/** First (primary) key string of a binding, e.g. 'e' for 'triage.done'. Reactive via the registry. */
export function hotkey(id: string): string | undefined {
  return keymap.byId(id)?.keys[0];
}

/** Display tokens for a binding's primary key, e.g. ['Shift+U'] or ['g i'] -> ['g', 'i']. */
export function hotkeyLabel(id: string): string[] {
  const k = hotkey(id);
  return k ? keyLabels(k) : [];
}

/** WAI-ARIA `aria-keyshortcuts` value; chords have no ARIA form, so they yield undefined. */
export function ariaShortcut(keys: string | undefined, isMac = keymap.isMac): string | undefined {
  if (!keys || /\s/.test(keys.trim())) return undefined;
  const s = parseStep(keys);
  const parts: string[] = [];
  if (s.mod) parts.push(isMac ? 'Meta' : 'Control');
  if (s.ctrl) parts.push('Control');
  if (s.meta) parts.push('Meta');
  if (s.alt) parts.push('Alt');
  const upper = s.key.length === 1 && s.key !== s.key.toLowerCase();
  if (s.shift || upper) parts.push('Shift');
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return parts.join('+');
}

/**
 * Run a binding by id exactly as its hotkey would (respecting `when`). Buttons use this so that
 * mouse and keyboard can never diverge.
 */
export function invoke(id: string): boolean {
  const b = keymap.byId(id);
  if (!b || (b.when && !b.when())) return false;
  b.run();
  return true;
}
