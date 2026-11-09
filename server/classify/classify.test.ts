import { describe, expect, it } from 'vitest';
import { buildSample, rng } from './sample.js';
import { score } from './score.js';
import { truthFor, weakTruth } from './truth.js';
import type { EvalItem } from './types.js';

const base: EvalItem = {
  id: 'a',
  provider: 'youtube',
  kind: 'comment',
  container: 'v',
  title: null,
  author: '@a',
  text: 'hi',
  occurredAt: '2026-01-01T00:00:00Z',
  state: 'archived',
  stateSource: 'sync',
};
const mk = (o: Partial<EvalItem>): EvalItem => ({ ...base, ...o });

describe('weakTruth', () => {
  it('a later own reply or an explicit replied means a reply was needed', () => {
    expect(weakTruth(mk({ ownReply: 'thanks' }))?.verdict).toBe('needs_reply');
    expect(weakTruth(mk({ state: 'replied', stateSource: 'user' }))?.verdict).toBe('needs_reply');
  });
  it('done by the owner without a reply means none was needed', () => {
    expect(weakTruth(mk({ state: 'done', stateSource: 'user' }))?.verdict).toBe('no_reply_needed');
  });
  it('the bulk-imported archive says nothing', () => {
    expect(weakTruth(mk({}))).toBeNull();
  });
  it('a hand label always beats the weak signal', () => {
    const i = mk({ id: 'z', ownReply: 'thanks' });
    expect(truthFor(i, new Map([['z', 'spam' as const]]))).toEqual({ verdict: 'spam', source: 'hand' });
  });
});

describe('score', () => {
  const t = (verdict: 'needs_reply' | 'no_reply_needed' | 'spam') => ({ verdict, source: 'hand' as const });
  it('measures recall of needs_reply and precision of the hiding verdicts, and names the dangerous misses', () => {
    const r = score([
      { id: '1', truth: t('needs_reply'), predicted: 'needs_reply', confidence: 'high' },
      { id: '2', truth: t('needs_reply'), predicted: 'no_reply_needed', confidence: 'high' },
      { id: '3', truth: t('no_reply_needed'), predicted: 'no_reply_needed', confidence: 'medium' },
      { id: '4', truth: t('spam'), predicted: 'spam', confidence: 'high' },
    ]);
    expect(r.needsReplyRecall).toBe(0.5);
    expect(r.noReplyPrecision).toBe(0.5);
    expect(r.spamPrecision).toBe(1);
    expect(r.dangerous).toEqual(['2']);
  });
  it('reports null, not a flattering number, when a class is absent', () => {
    expect(score([]).needsReplyRecall).toBeNull();
  });
});

describe('buildSample', () => {
  const items = Array.from({ length: 300 }, (_, i) =>
    mk({
      id: `c${i}`,
      text: i % 2 ? 'why?' : 'nice',
      occurredAt: '2026-02-01T00:00:00Z',
      ownReply: i % 3 ? null : 'r',
    }),
  );
  it('is reproducible for a seed, has no duplicates, and varies with another seed', () => {
    const a = buildSample(items, 1).map((s) => s.item.id);
    expect(buildSample(items, 1).map((s) => s.item.id)).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
    expect(buildSample(items, 2).map((s) => s.item.id)).not.toEqual(a);
  });
  it('gives a thin stratum what it has instead of failing', () => {
    expect(() => buildSample(items.slice(0, 3))).not.toThrow();
  });
  it('a later round never reuses excluded ids', () => {
    const first = new Set(buildSample(items, 1).map((s) => s.item.id));
    expect(buildSample(items, 2, { exclude: first }).some((s) => first.has(s.item.id))).toBe(false);
  });
  it('rng stays in [0,1)', () => {
    const r = rng(7);
    for (let i = 0; i < 1000; i++) expect(r()).toBeLessThan(1);
  });
});
