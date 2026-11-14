import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keymap, ariaShortcut, keyLabels } from './keymap.svelte';
import { appBindings, inboxBindings } from './bindings';

function key(k: string, init: KeyboardEventInit = {}, target?: HTMLElement) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  if (target) Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('keymap', () => {
  let km: Keymap;
  beforeEach(() => {
    vi.useFakeTimers();
    km = new Keymap();
    km.isMac = false;
  });
  afterEach(() => vi.useRealTimers());

  const bind = (keys: string[], run = vi.fn(), extra: Record<string, unknown> = {}) => {
    km.register({ id: keys.join(), keys, scope: 'global', group: 'App', description: 'x', run, ...extra });
    return run;
  };

  it('matches simple keys and alternates', () => {
    const run = bind(['j', 'ArrowDown']);
    km.handle(key('j'));
    km.handle(key('ArrowDown'));
    km.handle(key('k'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('distinguishes case via e.key (J vs j) and matches ?', () => {
    const lower = bind(['j']);
    const upper = bind(['J']);
    const help = bind(['?']);
    km.handle(key('J', { shiftKey: true }));
    km.handle(key('?', { shiftKey: true }));
    expect(lower).not.toHaveBeenCalled();
    expect(upper).toHaveBeenCalledTimes(1);
    expect(help).toHaveBeenCalledTimes(1);
  });

  it('resolves $mod to Ctrl off macOS and Meta on macOS', () => {
    const run = bind(['$mod+k']);
    km.handle(key('k', { metaKey: true }));
    expect(run).not.toHaveBeenCalled();
    km.handle(key('k', { ctrlKey: true }));
    expect(run).toHaveBeenCalledTimes(1);
    km.isMac = true;
    km.handle(key('k', { metaKey: true }));
    expect(run).toHaveBeenCalledTimes(2);
    km.handle(key('k', { ctrlKey: true }));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('ignores auto-repeat unless the binding opts in (navigation)', () => {
    const triage = bind(['e']);
    const nav = bind(['j'], vi.fn(), { repeat: true });
    km.handle(key('e'));
    km.handle(key('e', { repeat: true }));
    km.handle(key('e', { repeat: true }));
    km.handle(key('j'));
    km.handle(key('j', { repeat: true }));
    expect(triage).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledTimes(2);
  });

  it('does not fire plain bindings when a modifier is held', () => {
    const run = bind(['z']);
    km.handle(key('z', { ctrlKey: true }));
    expect(run).not.toHaveBeenCalled();
  });

  it('supports chords with a pending hint and a 1s timeout', () => {
    const run = bind(['g i']);
    km.handle(key('g'));
    expect(km.pendingChord).toBe('g');
    km.handle(key('i'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(km.pendingChord).toBeNull();

    km.handle(key('g'));
    vi.advanceTimersByTime(1001);
    expect(km.pendingChord).toBeNull();
    km.handle(key('i'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a broken chord restarts with the new key', () => {
    const g = bind(['g i']);
    const x = bind(['x']);
    km.handle(key('g'));
    km.handle(key('x'));
    expect(g).not.toHaveBeenCalled();
    expect(x).toHaveBeenCalledTimes(1);
  });

  it('exclusive scopes block lower scopes except global bindings', () => {
    const lower = bind(['e']);
    const pal = bind(['$mod+k'], vi.fn(), { global: true });
    const inModal = vi.fn();
    km.register({ id: 'm', keys: ['e'], scope: 'palette', group: 'App', description: '', run: inModal });
    const pop = km.pushScope('palette');
    km.handle(key('e'));
    expect(lower).not.toHaveBeenCalled();
    expect(inModal).toHaveBeenCalledTimes(1);
    km.handle(key('k', { ctrlKey: true }));
    expect(pal).toHaveBeenCalledTimes(1);
    pop();
    km.handle(key('e'));
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it('non-exclusive scopes fall through, with the top scope winning', () => {
    const base = bind(['j']);
    const baseOther = bind(['e']);
    const top = vi.fn();
    km.register({ id: 't', keys: ['j'], scope: 'thread', group: 'App', description: '', run: top });
    km.pushScope('thread');
    km.handle(key('j'));
    km.handle(key('e'));
    expect(top).toHaveBeenCalledTimes(1);
    expect(base).not.toHaveBeenCalled();
    expect(baseOther).toHaveBeenCalledTimes(1);
  });

  it('ignores single keys in editable targets but allows modifiers and Escape', () => {
    const single = bind(['e']);
    const send = bind(['$mod+Enter']);
    const esc = bind(['Escape']);
    const ta = document.createElement('textarea');
    document.body.append(ta);
    km.handle(key('e', {}, ta));
    expect(single).not.toHaveBeenCalled();
    km.handle(key('Enter', { ctrlKey: true }, ta));
    expect(send).toHaveBeenCalledTimes(1);
    km.handle(key('Escape', {}, ta));
    expect(esc).toHaveBeenCalledTimes(1);
    ta.remove();
  });

  it('respects when() and unregisters', () => {
    let on = false;
    const run = vi.fn();
    const off = km.register({
      id: 'w',
      keys: ['w'],
      scope: 'global',
      group: 'App',
      description: '',
      when: () => on,
      run,
    });
    km.handle(key('w'));
    expect(run).not.toHaveBeenCalled();
    on = true;
    km.handle(key('w'));
    expect(run).toHaveBeenCalledTimes(1);
    off();
    km.handle(key('w'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('formats key labels', () => {
    expect(keyLabels('$mod+Enter', false)).toEqual(['Ctrl+↵']);
    expect(keyLabels('$mod+Enter', true)).toEqual(['⌘↵']);
    expect(keyLabels('g i', false)).toEqual(['g', 'i']);
  });

  it('Shift+letter bindings are distinct from the plain letter', () => {
    const plain = bind(['u']);
    const shifted = bind(['Shift+U']);
    km.handle(key('U', { shiftKey: true }));
    expect(shifted).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
    km.handle(key('u'));
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('supports the * a / * n chords', () => {
    const all = bind(['* a']);
    const none = bind(['* n']);
    km.handle(key('*', { shiftKey: true }));
    km.handle(key('a'));
    km.handle(key('*', { shiftKey: true }));
    km.handle(key('n'));
    expect(all).toHaveBeenCalledTimes(1);
    expect(none).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter/Space to a focused button, but still fires other keys', () => {
    const enter = bind(['Enter']);
    const done = bind(['e']);
    const btn = document.createElement('button');
    expect(km.handle(key('Enter', {}, btn))).toBe(false);
    expect(km.handle(key(' ', {}, btn))).toBe(false);
    expect(enter).not.toHaveBeenCalled();
    km.handle(key('e', {}, btn));
    expect(done).toHaveBeenCalledTimes(1);
    km.handle(key('Enter', {}, document.body));
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it('formats aria-keyshortcuts', () => {
    expect(ariaShortcut('e')).toBe('E');
    expect(ariaShortcut('Shift+U')).toBe('Shift+U');
    expect(ariaShortcut('S')).toBe('Shift+S');
    expect(ariaShortcut('$mod+k', false)).toBe('Control+K');
    expect(ariaShortcut('g i')).toBeUndefined();
  });

  it('real bindings follow the Gmail-aligned map', () => {
    const keys = Object.fromEntries([...appBindings(), ...inboxBindings()].map((b) => [b.id, b.keys]));
    expect(keys['sync.now']).toEqual(['Shift+N']);
    expect(keys['sync.deep']).toEqual(['S']);
    expect(keys['triage.inbox']).toEqual(['Shift+U']);
    expect(keys['thread.back']).toContain('u');
    expect(keys['triage.done']).toEqual(['e', 'd']);
    expect(keys['sel.all']).toEqual(['* a']);
    expect(keys['sel.none']).toEqual(['* n']);
    const all = Object.values(keys).flat();
    expect(all.filter((k) => k === 'u')).toHaveLength(1);
  });
});

describe('snooze bindings', () => {
  const all = [...appBindings(), ...inboxBindings()];
  it('b and g z are each bound exactly once', () => {
    for (const k of ['b', 'g z']) {
      expect(all.filter((b) => b.keys.includes(k)).map((b) => b.id)).toHaveLength(1);
    }
    expect(all.find((b) => b.keys.includes('b'))?.id).toBe('snooze.open');
  });
  it('B snoozes again (only for an item that came back with no activity), and does not disturb b', () => {
    expect(all.filter((b) => b.keys.includes('B')).map((b) => b.id)).toEqual(['snooze.again']);
    expect(all.filter((b) => b.keys.includes('b')).map((b) => b.id)).toEqual(['snooze.open']);
  });
  it('l and g l are free now that labels are gone', () => {
    for (const k of ['l', 'g l']) expect(all.filter((b) => b.keys.includes(k))).toEqual([]);
  });
  it('binding ids are unique', () => {
    expect(new Set(all.map((b) => b.id)).size).toBe(all.length);
  });
});
