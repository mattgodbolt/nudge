import { describe, expect, it } from 'vitest';
import {
  defaultCustomTime,
  formatSnoozeDay,
  formatSnoozeTime,
  snoozeLine,
  fromLocalInputValue,
  recentlyWoken,
  snoozePresets,
  toLocalInputValue,
} from './snooze';

// All dates use local-time constructors so the tests hold in any timezone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const byId = (now: Date) => Object.fromEntries(snoozePresets(now).map((p) => [p.id, p.at]));

describe('snoozePresets', () => {
  it('Tuesday afternoon', () => {
    const now = at(2025, 11, 4, 14, 30); // Tue 4 Nov 2025
    const p = byId(now);
    expect(p.later).toEqual(at(2025, 11, 4, 17, 30));
    expect(p.tomorrow).toEqual(at(2025, 11, 5, 8, 0));
    expect(p.weekend).toEqual(at(2025, 11, 8, 8, 0)); // Saturday
    expect(p.nextweek).toEqual(at(2025, 11, 10, 8, 0)); // Monday
  });

  it('Friday: the weekend is tomorrow', () => {
    const p = byId(at(2025, 11, 7, 9, 0));
    expect(p.weekend).toEqual(at(2025, 11, 8, 8, 0));
    expect(p.nextweek).toEqual(at(2025, 11, 10, 8, 0));
  });

  it('Saturday and Sunday: the weekend preset is NEXT Saturday', () => {
    expect(byId(at(2025, 11, 8, 9, 0)).weekend).toEqual(at(2025, 11, 15, 8, 0));
    expect(byId(at(2025, 11, 9, 9, 0)).weekend).toEqual(at(2025, 11, 15, 8, 0));
  });

  it('Monday: next week is a full week away; Sunday: tomorrow', () => {
    expect(byId(at(2025, 11, 10, 9, 0)).nextweek).toEqual(at(2025, 11, 17, 8, 0));
    expect(byId(at(2025, 11, 9, 9, 0)).nextweek).toEqual(at(2025, 11, 10, 8, 0));
  });

  it('crosses month and year boundaries', () => {
    const p = byId(at(2025, 12, 31, 23, 0));
    expect(p.later).toEqual(at(2026, 1, 1, 2, 0));
    expect(p.tomorrow).toEqual(at(2026, 1, 1, 8, 0));
  });

  it('keeps 08:00 local across daylight-saving changes in any timezone', () => {
    // Walk every day of the year: wall-clock hour must always be exactly 8.
    for (let d = 0; d < 366; d++) {
      const now = at(2025, 1, 1 + d, 22, 15);
      for (const k of ['tomorrow', 'weekend', 'nextweek'] as const) {
        const t = byId(now)[k]!;
        expect([t.getHours(), t.getMinutes()]).toEqual([8, 0]);
        expect(t.getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });

  it('tomorrow morning is the custom default', () => {
    const now = at(2025, 11, 4, 14, 30);
    expect(defaultCustomTime(now)).toEqual(at(2025, 11, 5, 8, 0));
  });
});

describe('datetime-local conversion', () => {
  it('round-trips local time', () => {
    const d = at(2025, 3, 9, 8, 5);
    expect(toLocalInputValue(d)).toBe('2025-03-09T08:05');
    expect(fromLocalInputValue('2025-03-09T08:05')).toEqual(d);
  });
  it('rejects empty and malformed values', () => {
    expect(fromLocalInputValue('')).toBeNull();
    expect(fromLocalInputValue('tomorrow')).toBeNull();
  });
});

describe('formatSnoozeTime', () => {
  const now = at(2025, 11, 4, 14, 30);
  it('uses a weekday within a week', () => {
    expect(formatSnoozeTime(at(2025, 11, 5, 8, 0), now, 'en-US')).toBe('Wed 8:00 AM');
    expect(formatSnoozeTime(at(2025, 11, 4, 17, 30), now, 'en-US')).toBe('Tue 5:30 PM');
  });
  it('uses a date beyond a week, with the year only when it differs', () => {
    expect(formatSnoozeTime(at(2025, 11, 20, 8, 0), now, 'en-US')).toBe('Nov 20, 8:00 AM');
    expect(formatSnoozeTime(at(2026, 1, 2, 8, 0), now, 'en-US')).toBe('Jan 2, 2026, 8:00 AM');
  });
  it('accepts ISO strings and tolerates garbage', () => {
    expect(formatSnoozeTime(at(2025, 11, 5, 8, 0).toISOString(), now, 'en-US')).toBe('Wed 8:00 AM');
    expect(formatSnoozeTime('nope', now)).toBe('');
  });
});

describe('recentlyWoken', () => {
  const now = Date.parse('2025-11-04T12:00:00Z');
  it('is true within 24h only', () => {
    expect(recentlyWoken('2025-11-04T01:00:00Z', now)).toBe(true);
    expect(recentlyWoken('2025-11-03T11:00:00Z', now)).toBe(false);
    expect(recentlyWoken(null, now)).toBe(false);
  });
});

describe('formatSnoozeDay', () => {
  it('is the weekday within a week and the date beyond, with no time of day', () => {
    const now = at(2025, 11, 4, 14, 30); // Tue
    expect(formatSnoozeDay(at(2025, 11, 7, 8), now, 'en-US')).toBe('Fri');
    expect(formatSnoozeDay(at(2025, 11, 21, 8), now, 'en-US')).toBe('Nov 21');
    expect(formatSnoozeDay(at(2026, 1, 3, 8), now, 'en-US')).toBe('Jan 3, 2026');
    expect(formatSnoozeDay('nonsense', now)).toBe('');
  });
});

describe('snoozeLine', () => {
  it("is the owner's words, with the bucket left for the caller to style", () => {
    expect(snoozeLine({ why: 'wait for them', bucket: 'Waiting on them' })).toEqual({
      text: 'You snoozed this to: wait for them',
      bucket: 'Waiting on them',
    });
  });
  it('has no text without words, and nothing at all with no bucket either', () => {
    expect(snoozeLine({ why: null, bucket: 'In flight' })).toEqual({ text: '', bucket: 'In flight' });
    expect(snoozeLine({ why: null, bucket: null })).toEqual({ text: '', bucket: null });
  });
});
