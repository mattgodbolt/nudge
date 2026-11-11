import { describe, expect, it } from 'vitest';
import {
  CLIENT_USAGE_KEYS,
  MAX_COUNT_PER_KEY,
  SERVER_USAGE_KEYS,
  USAGE_FEATURES,
  USAGE_KEYS,
  actionKey,
  featureOf,
  isClientUsageKey,
  sanitizeCounts,
  viaOf,
} from './usage.js';

describe('the usage allow-list', () => {
  it('is only fixed lowercase feature names: nothing in it can carry user content', () => {
    for (const k of USAGE_KEYS) expect(k).toMatch(/^[a-z]+(_[a-z]+)*(\.[a-z]+(_[a-z]+)*)+$/);
  });

  it('has no duplicates and keeps server-only keys out of the browser list', () => {
    expect(new Set(USAGE_KEYS).size).toBe(USAGE_KEYS.length);
    for (const k of SERVER_USAGE_KEYS) expect(isClientUsageKey(k)).toBe(false);
    expect(CLIENT_USAGE_KEYS.length + SERVER_USAGE_KEYS.length).toBe(USAGE_KEYS.length);
  });

  it('builds action keys only for vias an action allows', () => {
    expect(actionKey('done', 'kbd')).toBe('done.kbd');
    expect(actionKey('nav', 'btn')).toBeNull();
    expect(actionKey('made_up', 'kbd')).toBeNull();
  });

  it('groups keys into features and reads the via back', () => {
    expect(featureOf('done.btn')).toBe('done');
    expect(featureOf('view.stats')).toBe('view.stats');
    expect(viaOf('done.touch')).toBe('touch');
    expect(viaOf('view.stats')).toBeNull();
    expect(USAGE_FEATURES).toContain('done');
    expect(USAGE_FEATURES).not.toContain('done.kbd');
  });
});

describe('sanitizeCounts', () => {
  it('accepts allow-listed keys with sane counts', () => {
    expect(sanitizeCounts({ 'done.kbd': 3, 'view.stats': 1 })).toEqual({
      accepted: { 'done.kbd': 3, 'view.stats': 1 },
      rejected: [],
    });
  });

  it('drops unknown keys, free-text lookalikes and server-only keys, and says which', () => {
    const r = sanitizeCounts({
      'done.kbd': 1,
      'search.run:hello world': 1,
      'item.abc123': 2,
      'assistant.cost_micros': 999999,
      '': 1,
    });
    expect(r.accepted).toEqual({ 'done.kbd': 1 });
    expect(r.rejected).toEqual(['search.run:hello world', 'item.abc123', 'assistant.cost_micros', '']);
  });

  it('caps counts and rejects non-integers, zero and negatives', () => {
    const r = sanitizeCounts({
      'done.kbd': MAX_COUNT_PER_KEY,
      'done.btn': MAX_COUNT_PER_KEY + 1,
      'done.touch': 1.5,
      'done.palette': 0,
      'snooze.kbd': -2,
      'snooze.btn': '3',
    });
    expect(r.accepted).toEqual({ 'done.kbd': MAX_COUNT_PER_KEY });
    expect(r.rejected).toHaveLength(5);
  });

  it('clips long rejected names and tolerates non-objects', () => {
    expect(sanitizeCounts({ ['x'.repeat(500)]: 1 }).rejected[0]!.length).toBeLessThanOrEqual(64);
    for (const bad of [null, undefined, 'x', 5, ['done.kbd']]) {
      expect(sanitizeCounts(bad)).toEqual({ accepted: {}, rejected: [] });
    }
  });
});
