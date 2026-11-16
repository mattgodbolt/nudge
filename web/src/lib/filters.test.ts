import { describe, expect, it } from 'vitest';
import { FILTER_KEYS, FILTER_QUERY_KEYS, clearedQuery, filtersFromQuery, hasFilters, sameFilters } from './filters';

describe('filters from the URL', () => {
  it('reads every filter the list understands, and nothing that is not one', () => {
    expect(
      filtersFromQuery({
        source: '3',
        video: 'v1',
        feed: '2',
        repo: 'org/app',
        kind: 'pr',
        who: 'people',
        sug: 'matt',
        q: 'hello',
        c: 'c1',
      }),
    ).toEqual({
      sourceId: 3,
      videoId: 'v1',
      feedId: 2,
      repo: 'org/app',
      kind: 'pr',
      audience: 'people',
      suggestion: 'matt',
      q: 'hello',
    });
  });

  it('drops values that are not valid', () => {
    expect(filtersFromQuery({ source: 'x', feed: '', kind: 'commit', who: 'aliens', sug: 'maybe', q: '' })).toEqual({});
  });

  it('every filter, whichever it is, counts as filtered (an empty list then says "Nothing matches")', () => {
    expect(hasFilters({})).toBe(false);
    for (const q of [{ who: 'bots' }, { kind: 'issue' }, { repo: 'o/r' }, { feed: '1' }, { sug: 'none' }, { q: 'x' }]) {
      expect(hasFilters(filtersFromQuery(q))).toBe(true);
    }
  });

  it('clearing removes every filter (and the cursor), and keeps nothing else', () => {
    const cleared = clearedQuery();
    expect(Object.keys(cleared).sort()).toEqual([...FILTER_QUERY_KEYS, 'c'].sort());
    expect(Object.values(cleared).every((v) => v === undefined)).toBe(true);
  });

  it('compares filter sets field by field', () => {
    expect(sameFilters({ q: '' }, {})).toBe(true);
    expect(sameFilters({ audience: 'bots' }, {})).toBe(false);
    expect(sameFilters(filtersFromQuery({ kind: 'pr', repo: 'a/b' }), { repo: 'a/b', kind: 'pr' })).toBe(true);
    expect(FILTER_KEYS).not.toContain('q');
  });
});
