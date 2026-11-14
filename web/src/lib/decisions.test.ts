import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ItemEventPost } from '../../../shared/api';
import { Decisions, buildDecisions } from './decisions';

let now = 0;
let send: Mock<(events: ItemEventPost[]) => Promise<unknown>>;
let d: Decisions;

const list = (n: number, pending = true) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, passable: pending }));
const iso = () => new Date(now).toISOString();
const settle = () => vi.advanceTimersByTimeAsync(0);

function make(extra: Partial<ConstructorParameters<typeof Decisions>[0]> = {}) {
  send = vi.fn<(events: ItemEventPost[]) => Promise<unknown>>().mockResolvedValue({ accepted: 1, rejected: 0 });
  d = new Decisions({
    send,
    now: () => now,
    doc: document,
    win: window,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...extra,
  });
  d.start({ demo: false });
}

beforeEach(() => {
  vi.useFakeTimers();
  now = Date.parse('2026-11-11T10:00:00.000Z');
  make();
});
afterEach(() => {
  d.stop();
  vi.useRealTimers();
});

describe('buildDecisions', () => {
  it('records rank, list size and the items passed over, nearest first', () => {
    const [e] = buildDecisions({ action: 'done', view: 'inbox', list: list(30), targets: ['i15'] }, 'key', iso());
    expect(e).toMatchObject({ kind: 'decision', itemId: 'i15', to: 'done' });
    expect(e!.meta).toEqual({
      view: 'inbox',
      rank: 15,
      listSize: 30,
      above: ['i14', 'i13', 'i12', 'i11', 'i10', 'i9', 'i8', 'i7', 'i6', 'i5'],
      input: 'key',
      bulk: false,
      selectionSize: 1,
    });
  });

  it('does not count bulk siblings or finished items as passed over, and flags bulk', () => {
    const l = list(5);
    l[2]!.passable = false;
    const es = buildDecisions({ action: 'done', view: 'all', list: l, targets: ['i3', 'i1'] }, 'button', iso());
    expect(es.map((e) => e.meta!.above)).toEqual([['i0'], ['i0']]);
    expect(es[0]!.meta).toMatchObject({ bulk: true, selectionSize: 2, rank: 3 });
  });

  it('uses a null rank for an item that is not in the list', () => {
    const [e] = buildDecisions({ action: 'snooze', view: 'inbox', list: list(3), targets: ['zzz'] }, 'other', iso());
    expect(e!.meta).toMatchObject({ rank: null, above: [], listSize: 3 });
  });
});

describe('Decisions', () => {
  const ctx = { action: 'done', view: 'inbox', list: list(3), targets: ['i1'] };

  it('does nothing until started, in demo mode, or when automated', () => {
    const off = new Decisions({ send, now: () => now });
    off.decide(ctx);
    expect(off.pending).toEqual([]);
    off.start({ demo: true });
    off.start({ demo: false, automated: true });
    off.decide(ctx);
    expect(off.pending).toEqual([]);
    expect(off.open('x', 'inbox')).toBeTypeOf('function');
  });

  it('batches on a timer and sends once', async () => {
    d.decide(ctx);
    d.decide({ ...ctx, targets: ['i2'] });
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toHaveLength(2);
    expect(d.pending).toEqual([]);
  });

  it('takes the input from the latest noted command, and "other" when stale or unknown', () => {
    expect(d.input()).toBe('other');
    d.noteInput('kbd');
    expect(d.input()).toBe('key');
    d.noteInput('btn');
    expect(d.input()).toBe('button');
    d.noteInput('palette');
    d.decide(ctx);
    expect(d.pending[0]!.meta!.input).toBe('palette');
    now += 31_000;
    expect(d.input()).toBe('other');
  });

  it('splits large batches into chunks of 50', async () => {
    for (let i = 0; i < 120; i++) d.decide(ctx);
    d.flush();
    expect(send.mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20]);
  });

  it('flushes when the page is hidden or goes away', () => {
    d.decide(ctx);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(send).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    d.decide(ctx);
    window.dispatchEvent(new Event('pagehide'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never throws or loses the UI when sending fails, and drops the batch', async () => {
    send.mockRejectedValue(new Error('offline'));
    d.decide(ctx);
    expect(() => d.flush()).not.toThrow();
    await settle();
    expect(d.pending).toEqual([]);
    send.mockImplementation(() => {
      throw new Error('sync boom');
    });
    d.decide(ctx);
    expect(() => d.flush()).not.toThrow();
  });

  it('records an open with dwell on close, clamped, and drops dwell under 300 ms', () => {
    d.noteInput('kbd');
    const close = d.open('a', 'inbox');
    now += 4_000;
    close();
    close(); // idempotent
    const quick = d.open('b', 'done');
    now += 100;
    quick();
    const long = d.open('c', 'inbox');
    now += 5 * 3_600_000;
    long();
    expect(d.pending.map((e) => [e.kind, e.itemId, e.to, e.meta])).toEqual([
      ['open', 'a', 'inbox', { input: 'key', dwellMs: 4000 }],
      ['open', 'b', 'done', { input: 'key' }],
      ['open', 'c', 'inbox', { input: 'key', dwellMs: 3_600_000 }],
    ]);
  });

  it('does not count time while the tab is hidden, and closes open items at pagehide', () => {
    d.open('a', 'inbox');
    now += 2_000;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    now += 600_000;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    now += 1_000;
    window.dispatchEvent(new Event('pagehide'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0][0]!.meta).toMatchObject({ dwellMs: 3000 });
  });
});
