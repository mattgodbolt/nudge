import { describe, expect, it } from 'vitest';
import { buildPairs, fitBradleyTerry, kendallTau, pairwiseAccuracy, selfConsistency } from './rank.js';
import type { Comparison } from './rank.js';

const ids = Array.from({ length: 20 }, (_, i) => `x${i}`);

describe('buildPairs', () => {
  const pairs = buildPairs(ids, 5, 4, 7);
  const base = pairs.filter((p) => !p.repeat);
  it('is deterministic for a seed and different for another', () => {
    expect(buildPairs(ids, 5, 4, 7)).toEqual(pairs);
    expect(buildPairs(ids, 5, 4, 8)).not.toEqual(pairs);
  });
  it('shows each item about once per round, never against itself, with no repeated pair', () => {
    const seen = new Set<string>();
    const count = new Map<string, number>();
    for (const p of base) {
      expect(p.a).not.toBe(p.b);
      const k = [p.a, p.b].sort().join('|');
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      for (const id of [p.a, p.b]) count.set(id, (count.get(id) ?? 0) + 1);
    }
    for (const id of ids) expect(count.get(id)).toBeGreaterThanOrEqual(4);
    for (const id of ids) expect(count.get(id)).toBeLessThanOrEqual(5);
  });
  it('re-asks some earlier pairs swapped, at the end, and numbers every pair in order', () => {
    const repeats = pairs.filter((p) => p.repeat);
    expect(repeats).toHaveLength(4);
    expect(pairs.map((p) => p.n)).toEqual(pairs.map((_, i) => i));
    for (const r of repeats) {
      expect(base.some((p) => p.a === r.b && p.b === r.a)).toBe(true);
    }
  });
});

/** A noiseless ground truth: lower index matters more. */
const truth = (i: number): number => -i;
function simulate(noise: number, seed = 3): Comparison[] {
  let s = seed;
  const r = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  return buildPairs(ids, 8, 0, 1).map((p) => {
    const d = truth(Number(p.a.slice(1))) - truth(Number(p.b.slice(1)));
    const flip = r() < noise;
    return { a: p.a, b: p.b, winner: d > 0 !== flip ? 'a' : 'b' };
  });
}

describe('fitBradleyTerry', () => {
  it('recovers the true order from clean comparisons', () => {
    const fit = fitBradleyTerry(simulate(0));
    const truthMap = new Map(ids.map((id, i) => [id, truth(i)]));
    // 8 comparisons per item cannot pin down a full order of 20 even without noise, so this is not 1.
    expect(kendallTau(fit, truthMap)).toBeGreaterThan(0.8);
  });
  it('stays close to the truth with some noise', () => {
    const fit = fitBradleyTerry(simulate(0.15));
    const truthMap = new Map(ids.map((id, i) => [id, truth(i)]));
    expect(kendallTau(fit, truthMap)).toBeGreaterThan(0.6);
  });
  it('keeps an undefeated item finite and centres the scores', () => {
    const fit = fitBradleyTerry([
      { a: 'w', b: 'l', winner: 'a' },
      { a: 'w', b: 'm', winner: 'a' },
      { a: 'm', b: 'l', winner: 'a' },
    ]);
    for (const v of fit.values()) expect(Number.isFinite(v)).toBe(true);
    expect(fit.get('w')!).toBeGreaterThan(fit.get('m')!);
    expect(fit.get('m')!).toBeGreaterThan(fit.get('l')!);
    expect([...fit.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(0, 6);
  });
  it('treats a tie as half a win each', () => {
    const fit = fitBradleyTerry([{ a: 'p', b: 'q', winner: 'tie' }]);
    expect(fit.get('p')).toBeCloseTo(fit.get('q')!, 6);
  });
});

describe('pairwiseAccuracy', () => {
  const cs: Comparison[] = [
    { a: 'a', b: 'b', winner: 'a' },
    { a: 'c', b: 'd', winner: 'b' },
    { a: 'e', b: 'f', winner: 'tie' },
  ];
  it('counts decided comparisons only and reports ties', () => {
    const s = new Map([
      ['a', 2],
      ['b', 1],
      ['c', 0],
      ['d', 5],
      ['e', 1],
      ['f', 1],
    ]);
    expect(pairwiseAccuracy(cs, (i) => s.get(i))).toEqual({ accuracy: 1, decided: 2, ties: 1 });
  });
  it('gives an equal score half credit and skips unscored items', () => {
    expect(pairwiseAccuracy(cs.slice(0, 1), () => 1).accuracy).toBe(0.5);
    expect(pairwiseAccuracy(cs, (i) => (i === 'a' ? 1 : undefined)).decided).toBe(0);
  });
});

describe('kendallTau', () => {
  it('is 1 for the same order, -1 for the reverse, null with no spread', () => {
    const x = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(kendallTau(x, x)).toBe(1);
    expect(
      kendallTau(
        x,
        new Map([
          ['a', 3],
          ['b', 2],
          ['c', 1],
        ]),
      ),
    ).toBe(-1);
    expect(
      kendallTau(
        x,
        new Map([
          ['a', 1],
          ['b', 1],
          ['c', 1],
        ]),
      ),
    ).toBeNull();
  });
});

describe('selfConsistency', () => {
  it('compares a re-asked pair with its first answer, whichever side it was shown on', () => {
    const r = selfConsistency([
      { a: 'p', b: 'q', winner: 'a' },
      { a: 'q', b: 'p', winner: 'b', repeat: true }, // swapped sides, same choice (p)
      { a: 'r', b: 's', winner: 'a' },
      { a: 's', b: 'r', winner: 'a', repeat: true }, // changed their mind
    ]);
    expect(r).toEqual({ agree: 1, of: 2 });
  });
});
