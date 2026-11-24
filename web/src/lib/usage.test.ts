import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CLIENT_USAGE_KEYS } from '../../../shared/usage';
import { BINDING_ACTIONS, Usage, isAutomated, usage as shared, viaOfEvent } from './usage';

let now = 0;
let send: Mock<(counts: Record<string, number>) => Promise<unknown>>;
let u: Usage;

function make(extra: Partial<ConstructorParameters<typeof Usage>[0]> = {}) {
  send = vi.fn<(counts: Record<string, number>) => Promise<unknown>>().mockResolvedValue({ accepted: 1, rejected: [] });
  u = new Usage({
    send,
    now: () => now,
    doc: document,
    win: window,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    setTick: setInterval,
    clearTick: clearInterval,
    ...extra,
  });
  return u;
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  make();
});
afterEach(() => {
  u.stop();
  vi.useRealTimers();
});

describe('Usage', () => {
  it('does nothing until started, and nothing at all in demo mode or when automated', async () => {
    u.count('done.kbd');
    u.action('done', 'kbd');
    expect(u.pending).toEqual({});
    u.start({ demo: true });
    u.start({ demo: false, automated: true });
    u.count('done.kbd');
    u.flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(u.enabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a test run as automated', () => {
    expect(isAutomated()).toBe(true);
    // The app-wide instance is inert until boot starts it.
    shared.count('done.kbd');
    expect(shared.pending).toEqual({});
  });

  it('batches increments and sends them once', async () => {
    u.start({ demo: false });
    await settle();
    send.mockClear();
    u.action('done', 'kbd');
    u.action('done', 'kbd');
    u.action('snooze', 'btn');
    u.count('view.stats');
    expect(send).not.toHaveBeenCalled();
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ 'done.kbd': 2, 'snooze.btn': 1, 'view.stats': 1 });
    expect(u.pending).toEqual({});
  });

  it('sends the first batch promptly, then at most once a minute', async () => {
    u.start({ demo: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1); // session.start and the device keys
    u.count('view.stats');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(send).toHaveBeenCalledTimes(1);
    now += 60_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('flushes when the page is hidden and on pagehide', async () => {
    u.start({ demo: false });
    await settle();
    send.mockClear();
    u.count('view.stats');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(send).toHaveBeenCalledWith({ 'view.stats': 1 });
    send.mockClear();
    u.count('view.done');
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(send).toHaveBeenCalledWith({ 'view.done': 1 });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('swallows a failed send and retries the same counts later', async () => {
    u.start({ demo: false });
    await settle();
    send.mockClear();
    send.mockRejectedValueOnce(new TypeError('offline'));
    u.count('view.stats');
    u.flush();
    await settle();
    expect(u.pending).toEqual({ 'view.stats': 1 });
    u.count('view.stats');
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenLastCalledWith({ 'view.stats': 2 });
    expect(u.pending).toEqual({});
  });

  it('drops a batch the server refuses as malformed rather than retrying forever', async () => {
    u.start({ demo: false });
    await settle();
    send.mockClear();
    send.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 400 }));
    u.count('view.stats');
    u.flush();
    await settle();
    expect(u.pending).toEqual({});
  });

  it('never throws into the caller, even when send throws synchronously', async () => {
    u.stop();
    make({
      send: () => {
        throw new Error('boom');
      },
    });
    u.start({ demo: false });
    expect(() => {
      u.count('view.stats');
      u.flush();
    }).not.toThrow();
    await settle();
    expect(u.pending['view.stats']).toBe(1);
  });

  it('ignores keys outside the allow-list, including ones that look like content', () => {
    u.start({ demo: false });
    u.count('search.run:cats');
    u.count('item.abc');
    u.count('done.kbd', 1.5);
    u.action('made_up', 'kbd');
    u.action('nav', 'btn');
    expect(Object.keys(u.pending).every((k) => CLIENT_USAGE_KEYS.includes(k))).toBe(true);
    expect(u.pending).toEqual({ 'session.start': 1, 'app.browser_tab': 1, 'device.desktop': 1 });
  });

  it('only ever holds allow-listed keys, whatever is thrown at it', () => {
    u.start({ demo: false });
    for (const k of ['<script>', 'x'.repeat(300), 'done', 'DONE.KBD', 'user@example.com']) u.count(k);
    for (const id of ['triage.done', 'palette.close', 'snooze.menu.n1', 'unknown']) u.binding(id, 'kbd');
    expect(Object.keys(u.pending).every((k) => CLIENT_USAGE_KEYS.includes(k))).toBe(true);
    expect(u.pending['done.kbd']).toBe(1);
  });

  it('maps keymap bindings to actions by invocation route', () => {
    u.start({ demo: false });
    u.binding('triage.done', 'kbd');
    u.binding('triage.done', 'btn');
    u.binding('triage.done', 'palette');
    u.binding('open.video', 'touch');
    expect(u.pending).toMatchObject({ 'done.kbd': 1, 'done.btn': 1, 'done.palette': 1, 'open_source.touch': 1 });
    for (const action of Object.values(BINDING_ACTIONS)) expect(action).toBeTruthy();
  });

  it('counts active minutes only when visible and the owner did something', async () => {
    u.start({ demo: false });
    await vi.advanceTimersByTimeAsync(60_000); // no input yet
    expect(u.pending['session.active_minute']).toBeUndefined();
    now += 60_000;
    window.dispatchEvent(new Event('keydown'));
    now += 30_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send.mock.calls.flatMap((c) => Object.keys(c[0] as object)).concat(Object.keys(u.pending))).toContain(
      'session.active_minute',
    );
  });

  it('starts a new session after a long absence', async () => {
    u.start({ demo: false });
    await settle();
    send.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    now += 31 * 60_000;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(u.pending['session.start']).toBe(1);
  });

  it('notices a long absence from the heartbeat when the page was frozen without a visibility event', async () => {
    u.start({ demo: false });
    await vi.advanceTimersByTimeAsync(60_000); // a first beat records the time
    await settle();
    send.mockClear();
    now += 45 * 60_000; // frozen: no visibilitychange, and no timers ran
    await vi.advanceTimersByTimeAsync(60_000);
    const starts = () =>
      send.mock.calls.reduce((n, c) => n + ((c[0] as Record<string, number>)['session.start'] ?? 0), 0) +
      (u.pending['session.start'] ?? 0);
    expect(starts()).toBe(1);
    // The visibility path seeing the same absence must not count it again.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(starts()).toBe(1);
  });

  it('counts a reply sent from the composer as replied', () => {
    u.start({ demo: false });
    u.binding('composer.send', 'kbd');
    u.binding('composer.send', 'touch');
    expect(u.pending).toMatchObject({ 'replied.kbd': 1, 'replied.touch': 1 });
  });

  it('reads a touch pointer as touch and anything else as the fallback', () => {
    expect(viaOfEvent({ pointerType: 'touch' } as unknown as Event)).toBe('touch');
    expect(viaOfEvent({ pointerType: 'mouse' } as unknown as Event)).toBe('btn');
    expect(viaOfEvent(new MouseEvent('click'))).toBe('btn');
    expect(viaOfEvent(undefined, 'btn')).toBe('btn');
  });
});
