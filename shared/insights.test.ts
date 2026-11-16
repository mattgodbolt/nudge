import { describe, expect, it } from 'vitest';
import { dayPart, fractionWords, insightsSentence, kindWord, SENTENCE_MIN_ACTIONS } from './insights.js';

const base = {
  range: '7d' as const,
  actions: 40,
  dealt: 30,
  dealtBy: [
    { provider: 'github', kind: 'pr', n: 20 },
    { provider: 'youtube', kind: 'comment', n: 10 },
  ],
  replied: 23,
  hourlyActions: null,
  loudest: null,
  agreement: null,
};

describe('the week in one sentence (F4)', () => {
  it('is quiet, kindly, under the minimum or with nothing dealt with, in words for the range', () => {
    expect(insightsSentence({ ...base, actions: SENTENCE_MIN_ACTIONS - 1 })).toBe('A quiet week. Lovely.');
    expect(insightsSentence({ ...base, dealt: 0 })).toBe('A quiet week. Lovely.');
    expect(insightsSentence({ ...base, range: '30d', actions: 0 })).toBe('A quiet month. Lovely.');
    expect(insightsSentence({ ...base, range: '90d', actions: 0 })).toBe('A quiet few months. Lovely.');
    expect(insightsSentence({ ...base, range: 'all', actions: 0 })).toBe('All quiet so far. Lovely.');
  });

  it('builds the doc example from the parts that cleared their minimums', () => {
    const hourly = new Array(24).fill(0);
    hourly[9] = 30;
    hourly[15] = 10;
    expect(
      insightsSentence({
        ...base,
        dealt: 23,
        hourlyActions: hourly,
        loudest: 'compiler-explorer',
        agreement: { hits: 8, total: 10 },
      }),
    ).toBe(
      'You answered 23 things, mostly PRs, mostly before lunch; compiler-explorer was the loudest and the robot agreed 4 times in 5.',
    );
  });

  it('leaves out what it cannot say: no majority kind, no part of the day, no loudest, no robot', () => {
    const even = [
      { provider: 'github', kind: 'pr', n: 15 },
      { provider: 'youtube', kind: 'comment', n: 15 },
    ];
    expect(insightsSentence({ ...base, dealtBy: even })).toBe('You answered 23 things and cleared 7 more.');
    expect(
      insightsSentence({ ...base, replied: 0, dealt: 1, dealtBy: [{ provider: 'todo', kind: 'todo', n: 1 }] }),
    ).toBe('You cleared 1 thing, mostly todos.');
    expect(insightsSentence({ ...base, dealtBy: even, agreement: { hits: 1, total: 20 } })).toBe(
      'You answered 23 things and cleared 7 more; the robot agreed hardly ever.',
    );
  });
});

describe('sentence parts', () => {
  it('turns a rate into friendly fractions', () => {
    expect(fractionWords(1)).toBe('basically every time');
    expect(fractionWords(0.8)).toBe('4 times in 5');
    expect(fractionWords(0.5)).toBe('1 time in 2');
    expect(fractionWords(0.67)).toBe('2 times in 3');
    expect(fractionWords(0.9)).toBe('9 times in 10');
    expect(fractionWords(0.2)).toBe('1 time in 5');
    expect(fractionWords(0.1)).toBe('hardly ever');
  });

  it('finds the part of the day only when it holds more than half, wrapping midnight', () => {
    const h = (pairs: [number, number][]) => {
      const a = new Array(24).fill(0);
      for (const [k, v] of pairs) a[k] = v;
      return a;
    };
    expect(dayPart(h([]))).toBeNull();
    expect(
      dayPart(
        h([
          [23, 3],
          [1, 3],
          [12, 5],
        ]),
      ),
    ).toBe('after midnight');
    expect(
      dayPart(
        h([
          [19, 6],
          [9, 5],
        ]),
      ),
    ).toBe('in the evening');
    expect(
      dayPart(
        h([
          [9, 5],
          [14, 5],
        ]),
      ),
    ).toBeNull();
  });

  it('names kinds, with a fallback for ones it does not know', () => {
    expect(kindWord('github', 'issue')).toBe('issues');
    expect(kindWord('youtube', 'comment')).toBe('YouTube comments');
    expect(kindWord('mastodon', 'toot')).toBe('mastodon toots');
  });
});
