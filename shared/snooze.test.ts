import { describe, expect, it } from 'vitest';
import {
  BUCKETS,
  DEFAULT_SNOOZE_DAYS,
  NO_BUCKET_DAYS,
  SNOOZE_BUCKETS,
  ageText,
  fallbackDate,
  isSnoozeBucket,
  nagText,
  wholeDays,
} from './snooze';

const DAY = 86_400_000;
const NOW = new Date('2026-11-14T12:00:00.000Z');

describe('snooze buckets', () => {
  it('has the defaults the owner asked for', () => {
    expect(DEFAULT_SNOOZE_DAYS).toEqual({ waiting_on_them: 7, waiting_on_merge: 3, in_flight: 7, lower_priority: 30 });
  });
  it('gives every bucket its own single-letter key, none of which is a digit or j/k/u', () => {
    const keys = SNOOZE_BUCKETS.map((b) => BUCKETS[b].key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z]$/);
    expect(keys).not.toContain('j');
    expect(keys).not.toContain('k');
    expect(keys).not.toContain('u');
  });
  it('recognises only real buckets', () => {
    expect(isSnoozeBucket('in_flight')).toBe(true);
    expect(isSnoozeBucket('whenever')).toBe(false);
    expect(isSnoozeBucket(null)).toBe(false);
  });
});

describe('fallbackDate', () => {
  it('adds the bucket days (from settings), or a week with no bucket', () => {
    expect(fallbackDate(NOW, 'waiting_on_merge', DEFAULT_SNOOZE_DAYS).getTime()).toBe(NOW.getTime() + 3 * DAY);
    expect(fallbackDate(NOW, 'lower_priority', { ...DEFAULT_SNOOZE_DAYS, lower_priority: 90 }).getTime()).toBe(
      NOW.getTime() + 90 * DAY,
    );
    expect(fallbackDate(NOW, null, DEFAULT_SNOOZE_DAYS).getTime()).toBe(NOW.getTime() + NO_BUCKET_DAYS * DAY);
  });
});

describe('wording', () => {
  it('says how long the wait was, rounding to whole days and never below one', () => {
    expect(wholeDays('2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z')).toBe(7);
    expect(wholeDays('2026-11-01T00:00:00.000Z', '2026-11-01T05:00:00.000Z')).toBe(1);
    expect(wholeDays(null, '2026-11-08T00:00:00.000Z')).toBe(1);
  });
  it('writes the audit line', () => {
    expect(nagText('waiting_on_them', 7)).toBe('Still waiting on them (7d, no activity)');
    expect(nagText('waiting_on_merge', 3)).toBe('Still waiting on merge / CI (3d, no activity)');
    expect(nagText(null, 7)).toBe('Still waiting (7d, no activity)');
  });
  it('writes compact ages', () => {
    const at = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
    expect(ageText(at(0), NOW.getTime())).toBe('today');
    expect(ageText(at(4), NOW.getTime())).toBe('4d');
    expect(ageText(at(15), NOW.getTime())).toBe('2w');
    expect(ageText(null, NOW.getTime())).toBe('');
  });
});
