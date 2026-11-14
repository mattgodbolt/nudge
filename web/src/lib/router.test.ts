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

  it('sends a bookmarked /label/:id (the retired labels feature) to the inbox', () => {
    expect(parseLocation('/label/12', '?q=hi').route).toBe('inbox');
    expect(parseLocation('/label', '').route).toBe('inbox');
  });

  it('builds paths that parse back', () => {
    expect(buildPath('snoozed')).toBe('/snoozed');
    expect(buildPath('snoozed', {}, { c: 'x' })).toBe('/snoozed?c=x');
    const url = new URL(buildPath('source', { id: '3' }), 'http://x');
    expect(parseLocation(url.pathname, url.search).params.id).toBe('3');
  });
});
