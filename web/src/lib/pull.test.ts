import { describe, expect, it } from 'vitest';
import { PULL_THRESHOLD, PullTracker } from './pull';

const drag = (t: PullTracker, from: [number, number], to: [number, number], scrollTop = 0) => {
  t.start(from[0], from[1], scrollTop);
  return t.move(to[0], to[1]);
};

describe('PullTracker', () => {
  it('fires after a long enough pull from the top, and only then', () => {
    const t = new PullTracker();
    drag(t, [100, 100], [100, 100 + 8 + PULL_THRESHOLD * 2 + 4]);
    expect(t.pulling).toBe(true);
    expect(t.end()).toBe(true);

    const short = new PullTracker();
    drag(short, [100, 100], [100, 140]);
    expect(short.pulling).toBe(true);
    expect(short.end()).toBe(false);
  });

  it('damps the distance and caps it', () => {
    const t = new PullTracker();
    expect(drag(t, [0, 0], [0, 8 + 100])).toBe(50);
    expect(t.move(0, 5000)).toBe(130);
  });

  it('ignores gestures that start below the top of the list', () => {
    const t = new PullTracker();
    expect(drag(t, [0, 0], [0, 400], 120)).toBe(0);
    expect(t.pulling).toBe(false);
    expect(t.end()).toBe(false);
  });

  it('ignores scrolling down and mostly-sideways swipes', () => {
    const down = new PullTracker();
    expect(drag(down, [0, 200], [0, 150])).toBe(0);
    // Coming back up after scrolling down within the same gesture must not turn into a pull.
    expect(down.move(0, 400)).toBe(0);
    expect(down.end()).toBe(false);

    const sideways = new PullTracker();
    expect(drag(sideways, [0, 0], [200, 60])).toBe(0);
    expect(sideways.pulling).toBe(false);
  });

  it('treats tiny movements as taps', () => {
    const t = new PullTracker();
    expect(drag(t, [0, 0], [2, 5])).toBe(0);
    expect(t.pulling).toBe(false);
  });

  it('resets between gestures', () => {
    const t = new PullTracker();
    drag(t, [0, 0], [0, 400]);
    expect(t.end()).toBe(true);
    expect(t.end()).toBe(false);
    expect(drag(t, [0, 0], [0, 20])).toBeGreaterThan(0);
  });
});
