import { describe, expect, it } from 'vitest';
import { createQuotaTracker, nextPacificMidnight, pacificDay } from './quota.js';
import { makeClock } from './test-helpers.js';
import { createRepo } from '../db/repo.js';
import { openDb } from '../db/db.js';

function setup(start: string, settings = { dailyQuotaBudget: 100, manualReserve: 20 }) {
  const clock = makeClock(new Date(start));
  const repo = createRepo(openDb(':memory:'), clock.now);
  repo.updateSettings(settings);
  const quota = createQuotaTracker({ repo, getSettings: () => repo.getSettings(), clock: clock.now });
  return { clock, repo, quota };
}

describe('pacific day', () => {
  it('uses Pacific, not UTC, for the day key', () => {
    expect(pacificDay(new Date('2026-03-10T06:59:00Z'))).toBe('2026-03-09'); // PDT: 23:59 prev day
    expect(pacificDay(new Date('2026-03-10T07:00:00Z'))).toBe('2026-03-10');
    expect(pacificDay(new Date('2026-01-10T07:59:00Z'))).toBe('2026-01-09'); // PST
    expect(pacificDay(new Date('2026-01-10T08:00:00Z'))).toBe('2026-01-10');
  });
  it('finds the next Pacific midnight, DST included', () => {
    expect(nextPacificMidnight(new Date('2026-07-01T20:00:00Z')).toISOString()).toBe('2026-07-02T07:00:00.000Z');
    expect(nextPacificMidnight(new Date('2026-01-01T20:00:00Z')).toISOString()).toBe('2026-01-02T08:00:00.000Z');
    // spring-forward day (2026-03-08) is 23h long
    expect(nextPacificMidnight(new Date('2026-03-08T09:00:00Z')).toISOString()).toBe('2026-03-09T07:00:00.000Z');
  });
});

describe('quota tracker', () => {
  it('charges against the current day and rolls over at Pacific midnight', () => {
    const { clock, quota } = setup('2026-03-10T05:00:00Z'); // 22:00 PDT on the 9th
    quota.charge('commentThreads', 1);
    quota.charge('commentThreads', 4);
    expect(quota.dayPt()).toBe('2026-03-09');
    expect(quota.used()).toBe(5);
    clock.advance(3 * 3_600_000); // 01:00 PDT on the 10th
    expect(quota.dayPt()).toBe('2026-03-10');
    expect(quota.used()).toBe(0);
  });
  it('respects budget and manual reserve', () => {
    const { quota } = setup('2026-03-10T12:00:00Z');
    quota.charge('x', 79);
    expect(quota.canPoll()).toBe(true);
    quota.charge('x', 1);
    expect(quota.canPoll()).toBe(false); // 80 = budget - reserve
    expect(quota.canManual()).toBe(true);
    quota.charge('x', 20);
    expect(quota.canManual()).toBe(false);
  });
  it('blocks until the next Pacific day then unblocks by itself', () => {
    const { clock, quota } = setup('2026-03-10T12:00:00Z');
    quota.blockUntilNextDay();
    expect(quota.canPoll()).toBe(false);
    expect(quota.canManual()).toBe(false);
    const snap = quota.snapshot();
    expect(snap.blockedUntil).toBe('2026-03-11T07:00:00.000Z');
    expect(snap).toMatchObject({ dayPt: '2026-03-10', used: 0, budget: 100, reserve: 20 });
    clock.advance(20 * 3_600_000);
    expect(quota.canPoll()).toBe(true);
    expect(quota.snapshot().blockedUntil).toBeNull();
  });
});
