import { describe, expect, it } from 'vitest';
import { buildPath, parseLocation } from './router.svelte';

describe('router', () => {
  it('parses the existing routes', () => {
    expect(parseLocation('/', '').route).toBe('inbox');
    expect(parseLocation('/done', '').route).toBe('done');
    expect(parseLocation('/all', '').route).toBe('all');
    expect(parseLocation('/sources/4', '')).toMatchObject({ route: 'source', params: { id: '4' } });
    expect(parseLocation('/settings', '').route).toBe('settings');
  });

  it('parses /snoozed', () => {
    expect(parseLocation('/snoozed', '?c=abc')).toEqual({ route: 'snoozed', params: {}, query: { c: 'abc' } });
  });

  it('parses /label/:id', () => {
    expect(parseLocation('/label/12', '?q=hi')).toEqual({ route: 'label', params: { id: '12' }, query: { q: 'hi' } });
  });

  it('falls back to the inbox for a malformed label route', () => {
    expect(parseLocation('/label', '').route).toBe('inbox');
    expect(parseLocation('/label/abc', '').route).toBe('inbox');
    expect(parseLocation('/label/0', '').route).toBe('inbox');
  });

  it('builds paths that parse back', () => {
    expect(buildPath('snoozed')).toBe('/snoozed');
    expect(buildPath('label', { id: '3' }, { c: 'x' })).toBe('/label/3?c=x');
    const url = new URL(buildPath('label', { id: '3' }), 'http://x');
    expect(parseLocation(url.pathname, url.search).params.id).toBe('3');
  });
});
