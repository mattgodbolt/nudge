import { describe, expect, it } from 'vitest';
import type { Insights } from '../../../shared/insights';
import {
  AGE_BAND_LABEL,
  SIZE_BAND_LABEL,
  busiestWindow,
  captions,
  dayLabel,
  heatLevel,
  hourLabel,
  loadRange,
  lowData,
  monthLabel,
  pct,
  perDayLabel,
  saveRange,
  shortDuration,
} from './insights';

describe('words and numbers', () => {
  it('labels hours, durations, shares and per-day averages', () => {
    expect([0, 1, 11, 12, 13, 23, 24].map(hourLabel)).toEqual(['12am', '1am', '11am', '12pm', '1pm', '11pm', '12am']);
    expect(
      [30_000, 45 * 60_000, 6 * 3_600_000, 47 * 3_600_000, 2 * 86_400_000, 120 * 86_400_000].map(shortDuration),
    ).toEqual(['<1m', '45m', '6h', '47h', '2d', '4mo']);
    expect(shortDuration(null)).toBe('–');
    expect([pct(0.4123), pct(1), pct(null)]).toEqual(['41%', '100%', '–']);
    expect([0, 0.25, 3, 3.04, 12.6].map(perDayLabel)).toEqual(['0', '0.3', '3', '3', '13']);
  });

  it('formats the size and age bands in order', () => {
    expect(Object.values(SIZE_BAND_LABEL)).toEqual(['No comments', '1–3 comments', '4–10 comments', '11 or more']);
    expect(Object.values(AGE_BAND_LABEL)).toEqual(['Under a day', '1–7 days', '1–4 weeks', '1–3 months', '3 months+']);
  });

  it('says how far a card is from enough', () => {
    expect(lowData({ n: 12, min: 50, data: null })).toBe('Not enough data yet (12 of 50)');
  });

  it('steps the sequential ramp from 1 to 7, with 0 only for nothing at all', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(0.01, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBe(4);
    expect(heatLevel(10, 10)).toBe(7);
    expect(heatLevel(3, 0)).toBe(0);
  });

  it('dates', () => {
    expect(dayLabel('2026-10-14')).toBe('14 Oct');
    expect(monthLabel('2026-03-05T10:00:00Z', new Date('2026-11-16T00:00:00Z'))).toBe('March');
    expect(monthLabel('2025-03-05T10:00:00Z', new Date('2026-11-16T00:00:00Z'))).toBe('March 2025');
  });

  it('finds the busiest two hours, across midnight too', () => {
    const h = new Array(24).fill(0);
    h[8] = 5;
    h[9] = 4;
    expect(busiestWindow(h)).toEqual({ from: 8, label: '8–10am' });
    const late = new Array(24).fill(0);
    late[23] = 3;
    late[0] = 3;
    expect(busiestWindow(late)?.label).toBe('11pm–1am');
    expect(busiestWindow(new Array(24).fill(0))).toBeNull();
  });
});

describe('the remembered range', () => {
  it('defaults to 30d, remembers a valid choice, and survives broken or missing storage', () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadRange(s)).toBe('30d');
    saveRange('7d', s);
    expect(loadRange(s)).toBe('7d');
    store.set('nudge.insights.range', 'forever');
    expect(loadRange(s)).toBe('30d');
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadRange(broken)).toBe('30d');
    expect(() => saveRange('90d', broken)).not.toThrow();
    expect(loadRange(null)).toBe('30d');
  });
});

describe('captions describe, never scold', () => {
  const ins = (patch: (i: Insights) => void): Insights => {
    const empty = { n: 0, min: 1, data: null };
    const i = {
      rhythm: { arrivals: empty, actions: empty, hourly: empty, firstResponse: empty },
      responses: {
        outcomes: empty,
        replyBySource: empty,
        replyBySize: empty,
        ageWhenAnswered: empty,
        snoozes: empty,
        undos: empty,
      },
      predictions: {
        agreement: empty,
        bySuggestion: empty,
        calibration: empty,
        confusion: empty,
        categories: empty,
        turns: empty,
      },
      sources: { repos: empty, videos: empty, channels: empty, regulars: empty, threads: empty, mix: empty },
      backlog: { inboxAge: empty, elder: empty, snoozedNow: empty, overTime: empty },
      extras: { busiestDay: empty, quietestHour: empty, biggestCleared: empty, polyglot: empty },
    } as unknown as Insights;
    patch(i);
    return i;
  };

  it('has nothing to say without data', () => {
    const i = ins(() => {});
    for (const [name, f] of Object.entries(captions)) {
      expect((f as (x: Insights, ...a: unknown[]) => string | null)(i, [], []), name).toBeNull();
    }
  });

  it('the doc examples', () => {
    expect(
      captions.arrivals(
        ins((i) => {
          i.rhythm.arrivals = {
            n: 60,
            min: 50,
            data: { peak: { weekday: 2, hour: 16, perDay: 3, count: 12 } } as never,
          };
        }),
      ),
    ).toBe('Peak arrivals: Tuesdays 4pm. The internet has opinions after lunch.');
    expect(
      captions.agreement(
        ins(
          (i) =>
            (i.predictions.agreement = { n: 212, min: 30, data: { hits: 166, total: 212, ambiguous: 0, bulk: 0 } }),
        ),
      ),
    ).toBe('Agreed with you 78% of the time (n=212). A decent sidekick.');
    expect(captions.undos(ins((i) => (i.responses.undos = { n: 9, min: 1, data: { undos: 7, actions: 90 } })))).toBe(
      "Ctrl+Z: used 7 times. Nobody's perfect.",
    );
    expect(captions.undos(ins((i) => (i.responses.undos = { n: 9, min: 1, data: { undos: 0, actions: 9 } })))).toBe(
      'Ctrl+Z: not needed once. Bold.',
    );
    expect(
      captions.busiestDay(
        ins((i) => (i.extras.busiestDay = { n: 1, min: 1, data: { day: '2026-10-14', actions: 93 } })),
      ),
    ).toBe('14 Oct: 93 things. You survived.');
    expect(
      captions.quietestHour(ins((i) => (i.extras.quietestHour = { n: 60, min: 50, data: { hour: 4, perDay: 0 } }))),
    ).toBe('Nothing much ever happens at 4am. Respect.');
  });

  it('outcome shares add up from the counts, and size captions only compare measured bands', () => {
    const counts = { replied: 41, done: 30, dismissed: 18, snoozed: 6, legacy: 0, upstream: 5 };
    expect(
      captions.outcomes(
        ins((i) => (i.responses.outcomes = { n: 100, min: 20, data: { counts, waiting: 0, bulk: 0 } })),
      ),
    ).toBe('41% replied, 30% done, 18% waved through.');
    const rows = (small: number | null, big: number | null) => [
      { band: '0', n: 0, hits: 0, rate: null },
      { band: '1-3', n: 10, hits: 0, rate: small },
      { band: '4-10', n: 0, hits: 0, rate: null },
      { band: '11+', n: 10, hits: 0, rate: big },
    ];
    const size = (small: number | null, big: number | null) =>
      captions.replyBySize(
        ins(
          (i) =>
            (i.responses.replyBySize = {
              n: 20,
              min: 10,
              data: { rowMin: 10, rows: rows(small, big), approx: 0 } as never,
            }),
        ),
      );
    expect(size(0.8, 0.2)).toBe('Short threads get answers; epics get the slow treatment.');
    expect(size(0.2, 0.8)).toBe('The big conversations pull you in.');
    expect(size(0.5, 0.52)).toBe('Thread size makes little difference to whether you reply.');
    expect(size(null, 0.8)).toBeNull();
  });

  it('never uses guilt words', () => {
    const all =
      JSON.stringify(captions.toString()) +
      Object.values(captions)
        .map((f) => f.toString())
        .join('\n');
    expect(all).not.toMatch(/\b(slow you|you are slow|behind|overdue|lazy|should have|failed)\b/i);
  });
});
