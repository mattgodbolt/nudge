import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  fitBradleyTerry,
  groupsToComparisons,
  kendallTau,
  pairwiseAccuracy,
  selfConsistency,
} from './rank.js';
import type { Comparison } from './rank.js';

const ids = Array.from({ length: 20 }, (_, i) => `x${i}`);

describe('buildGroups', () => {
  const groups = buildGroups(ids, 4, 3, 3, 7);
  const base = groups.filter((g) => !g.repeat);
  it('is deterministic for a seed and different for another', () => {
    expect(buildGroups(ids, 4, 3, 3, 7)).toEqual(groups);
    expect(buildGroups(ids, 4, 3, 3, 8)).not.toEqual(groups);
  });
  it('shows every item once per round, in distinct groups of the right size', () => {
    const count = new Map<string, number>();
    const seen = new Set<string>();
    for (const g of base) {
      expect(g.ids).toHaveLength(4);
      expect(new Set(g.ids).size).toBe(4);
      const k = [...g.ids].sort().join('|');
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      for (const id of g.ids) count.set(id, (count.get(id) ?? 0) + 1);
    }
    for (const id of ids) expect(count.get(id)).toBe(3);
  });
  it('groups time neighbours first, then mixes them', () => {
    expect(new Set(base[0]!.ids)).toEqual(new Set(['x0', 'x1', 'x2', 'x3']));
    expect(new Set(base[5]!.ids)).toEqual(new Set(['x2', 'x3', 'x4', 'x5']));
  });
  it('re-asks some earlier groups reshuffled at the end and numbers every group in order', () => {
    const repeats = groups.filter((g) => g.repeat);
    expect(repeats).toHaveLength(3);
    expect(groups.map((g) => g.n)).toEqual(groups.map((_, i) => i));
    for (const r of repeats) {
      expect(base.some((g) => [...g.ids].sort().join() === [...r.ids].sort().join())).toBe(true);
    }
  });
});

describe('groupsToComparisons', () => {
  it('orders ranked items, puts them above the unranked rest and ties the rest', () => {
    const cs = groupsToComparisons([{ ids: ['p', 'q', 'r', 's'], order: ['q', 'p'] }]);
    expect(cs).toContainEqual({ a: 'q', b: 'p', winner: 'a', repeat: undefined });
    expect(cs.filter((c) => c.winner === 'a')).toHaveLength(5); // q>p, q>r, q>s, p>r, p>s
    expect(cs.filter((c) => c.winner === 'tie')).toEqual([{ a: 'r', b: 's', winner: 'tie', repeat: undefined }]);
  });
  it('gives six comparisons for a fully ranked group and carries the repeat flag', () => {
    const cs = groupsToComparisons([{ ids: ['a', 'b', 'c', 'd'], order: ['a', 'b', 'c', 'd'], repeat: true }]);
    expect(cs).toHaveLength(6);
    expect(cs.every((c) => c.repeat)).toBe(true);
  });
  it('ignores ranked ids that are not in the group', () => {
    expect(groupsToComparisons([{ ids: ['a', 'b'], order: ['zzz', 'a'] }])).toHaveLength(1);
  });
});

/** A noiseless ground truth: lower index matters more. */
const truth = (i: number): number => -i;
function simulate(noise: number, seed = 3): Comparison[] {
  let s = seed;
  const r = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const out: Comparison[] = [];
  for (const g of buildGroups(ids, 4, 6, 0, 1)) {
    // The owner orders each group by the true value, with some noise in what he perceives.
    const seenValue = new Map(g.ids.map((id) => [id, truth(Number(id.slice(1))) + (r() - 0.5) * noise * 20]));
    const order = [...g.ids].sort((x, y) => seenValue.get(y)! - seenValue.get(x)!);
    out.push(...groupsToComparisons([{ ids: g.ids, order }]));
  }
  return out;
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
