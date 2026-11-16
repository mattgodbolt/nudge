import { describe, expect, it } from 'vitest';
import { colder, infoForTier, tierFor, unitsPerDay } from './tiers.js';

const now = new Date('2026-03-10T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

describe('tierFor', () => {
  it('maps age to tier boundaries', () => {
    expect(tierFor(ago(0.1), null, now).tier).toBe('hot');
    expect(tierFor(ago(2.99), null, now).tier).toBe('hot');
    expect(tierFor(ago(3), null, now).tier).toBe('warm');
    expect(tierFor(ago(29), null, now).tier).toBe('warm');
    expect(tierFor(ago(30), null, now).tier).toBe('cold');
    expect(tierFor(ago(364), null, now).tier).toBe('cold');
    expect(tierFor(ago(365), null, now).tier).toBe('frozen');
  });
  it('carries intervals and deep-scan cadence from the plan', () => {
    expect(tierFor(ago(1), null, now)).toEqual({ tier: 'hot', intervalMin: 10, deepEveryMin: 360 });
    expect(tierFor(ago(10), null, now)).toEqual({ tier: 'warm', intervalMin: 60, deepEveryMin: 1440 });
    expect(tierFor(ago(100), null, now)).toEqual({ tier: 'cold', intervalMin: 720, deepEveryMin: 10080 });
    expect(tierFor(ago(900), null, now)).toEqual({ tier: 'frozen', intervalMin: 2880, deepEveryMin: 43200 });
  });
  it('honours overrides, including paused (never polled)', () => {
    expect(tierFor(ago(900), 'hot', now).tier).toBe('hot');
    const p = tierFor(ago(1), 'paused', now);
    expect(p.intervalMin).toBe(Infinity);
    expect(p.deepEveryMin).toBe(Infinity);
  });
  it('treats unknown publish dates as cold', () => {
    expect(tierFor(null, null, now).tier).toBe('cold');
  });
  it('colder() steps down and saturates', () => {
    expect(colder(tierFor(ago(1), null, now)).tier).toBe('warm');
    expect(colder(tierFor(ago(900), null, now)).tier).toBe('frozen');
    expect(colder(tierFor(ago(1), 'paused', now)).tier).toBe('paused');
  });
});

describe('unitsPerDay', () => {
  it('is one unit per poll, and nothing for a paused video', () => {
    expect(unitsPerDay(infoForTier('hot'))).toBe(144);
    expect(unitsPerDay(infoForTier('warm'))).toBe(24);
    expect(unitsPerDay(infoForTier('cold'))).toBe(2);
    expect(unitsPerDay(infoForTier('frozen'))).toBe(0.5);
    expect(unitsPerDay(tierFor(null, 'paused', now))).toBe(0);
  });
});
