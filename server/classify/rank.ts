// Priority ranking, offline (issue #27). The owner gives pairwise comparisons ("which matters more?"); a
// Bradley-Terry fit turns them into one score per item, which is the reference a model's priority is measured against.
import { rng } from './sample.js';

/** A small set shown together; the owner orders it (as they would handle it) and may flag what must happen today. */
export interface Group {
  /** Position in the sequence shown: the answer document is `g<n>`. */
  n: number;
  ids: string[];
  /** A deliberate re-ask of an earlier group with the order reshuffled, to measure the owner's own consistency. */
  repeat?: boolean;
}

/** One answered group: `order` is best-first among the items the owner ranked; anything left out is "the rest, equal". */
export interface GroupAnswer {
  ids: string[];
  order: string[];
  today?: string[];
  repeat?: boolean;
}

/** a: the left item matters more; b: the right one; tie: about equal or cannot say. */
export type Winner = 'a' | 'b' | 'tie';
export interface Comparison {
  a: string;
  b: string;
  winner: Winner;
}

/**
 * Groups of `size` items. The ids are expected sorted by arrival time: the first round groups time neighbours (the
 * closest thing to "what landed together in a day"), the second shifts those by half a group so neighbours mix, and
 * later rounds are random shuffles. Every item appears once per round. A few earlier groups are re-asked at the end
 * with their order reshuffled.
 */
export function buildGroups(ids: string[], size: number, rounds: number, repeats: number, seed = 1): Group[] {
  const rand = rng(seed);
  const shuffle = <T>(xs: T[]): T[] => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const out: Group[] = [];
  const seen = new Set<string>();
  const push = (members: string[]): void => {
    const k = [...members].sort().join('|');
    if (members.length < 2 || seen.has(k)) return;
    seen.add(k);
    out.push({ n: out.length, ids: shuffle(members) });
  };
  const half = Math.floor(size / 2);
  for (let r = 0; r < rounds; r++) {
    const order = r === 0 ? ids : r === 1 ? [...ids.slice(half), ...ids.slice(0, half)] : shuffle(ids);
    for (let i = 0; i < order.length; i += size) {
      const chunk = order.slice(i, i + size);
      // A short last chunk borrows from the start so no group is a pair of leftovers.
      push(chunk.length < size ? [...chunk, ...order.slice(0, size - chunk.length)] : chunk);
    }
  }
  const base = out.length;
  for (const g of shuffle(out.slice(0, Math.max(0, base - 4))).slice(0, repeats)) {
    out.push({ n: out.length, ids: shuffle(g.ids), repeat: true });
  }
  return out;
}

/** Ordered items beat later ones and the unranked rest; the rest tie among themselves. */
export function groupsToComparisons(answers: GroupAnswer[]): (Comparison & { repeat?: boolean })[] {
  const out: (Comparison & { repeat?: boolean })[] = [];
  for (const g of answers) {
    const ranked = g.order.filter((i) => g.ids.includes(i));
    const rest = g.ids.filter((i) => !ranked.includes(i));
    const add = (a: string, b: string, winner: Winner): void => void out.push({ a, b, winner, repeat: g.repeat });
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) add(ranked[i]!, ranked[j]!, 'a');
      for (const u of rest) add(ranked[i]!, u, 'a');
    }
    for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) add(rest[i]!, rest[j]!, 'tie');
  }
  return out;
}

/**
 * Bradley-Terry strengths by minorisation-maximisation, with a small prior (each item gets half a win and half a
 * loss against a virtual average opponent) so an item that always wins or always loses stays finite. A tie counts as
 * half a win to each side. Returns log-strengths centred on zero.
 */
export function fitBradleyTerry(comparisons: Comparison[], iterations = 200): Map<string, number> {
  const ids = [...new Set(comparisons.flatMap((c) => [c.a, c.b]))];
  const w = new Map(ids.map((i) => [i, 0.5])); // prior wins
  const games = new Map<string, Map<string, number>>(); // total games between pairs
  const bump = (a: string, b: string, n: number): void => {
    if (!games.has(a)) games.set(a, new Map());
    games.get(a)!.set(b, (games.get(a)!.get(b) ?? 0) + n);
  };
  for (const c of comparisons) {
    const aw = c.winner === 'a' ? 1 : c.winner === 'tie' ? 0.5 : 0;
    w.set(c.a, w.get(c.a)! + aw);
    w.set(c.b, w.get(c.b)! + (1 - aw));
    bump(c.a, c.b, 1);
    bump(c.b, c.a, 1);
  }
  let p = new Map(ids.map((i) => [i, 1]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    for (const i of ids) {
      // The virtual opponent has strength 1 and plays one game against everyone (the prior).
      let denom = 1 / (p.get(i)! + 1);
      for (const [j, n] of games.get(i) ?? []) denom += n / (p.get(i)! + p.get(j)!);
      next.set(i, w.get(i)! / denom);
    }
    const geo = Math.exp([...next.values()].reduce((s, v) => s + Math.log(v), 0) / ids.length);
    p = new Map([...next].map(([i, v]) => [i, v / geo]));
  }
  return new Map([...p].map(([i, v]) => [i, Math.log(v)]));
}

/** Share of decided comparisons (ties excluded) that a scoring orders the same way the owner did. */
export function pairwiseAccuracy(
  comparisons: Comparison[],
  score: (id: string) => number | undefined,
): { accuracy: number | null; decided: number; ties: number } {
  let ok = 0;
  let decided = 0;
  let ties = 0;
  for (const c of comparisons) {
    if (c.winner === 'tie') {
      ties++;
      continue;
    }
    const a = score(c.a);
    const b = score(c.b);
    if (a === undefined || b === undefined) continue;
    decided++;
    // A scoring that gives both the same value is a coin flip, not a hit.
    if (a === b) ok += 0.5;
    else if (a > b === (c.winner === 'a')) ok++;
  }
  return { accuracy: decided ? ok / decided : null, decided, ties };
}

/** Kendall's tau-b between two scorings of the same items (ties handled). */
export function kendallTau(xs: Map<string, number>, ys: Map<string, number>): number | null {
  const ids = [...xs.keys()].filter((i) => ys.has(i));
  let conc = 0;
  let disc = 0;
  let tx = 0;
  let ty = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const dx = Math.sign(xs.get(ids[i]!)! - xs.get(ids[j]!)!);
      const dy = Math.sign(ys.get(ids[i]!)! - ys.get(ids[j]!)!);
      if (dx === 0 && dy === 0) continue;
      if (dx === 0) tx++;
      else if (dy === 0) ty++;
      else if (dx === dy) conc++;
      else disc++;
    }
  }
  const denom = Math.sqrt((conc + disc + tx) * (conc + disc + ty));
  return denom === 0 ? null : (conc - disc) / denom;
}

/** How often the owner gave the same answer when a pair was asked twice (the ceiling for any model). */
export function selfConsistency(comparisons: (Comparison & { repeat?: boolean })[]): {
  agree: number;
  of: number;
} {
  const first = new Map<string, Winner>();
  let agree = 0;
  let of = 0;
  for (const c of comparisons) {
    const k = [c.a, c.b].sort().join('|');
    // Normalise to "did the alphabetically first id win".
    const orient = (w: Winner): Winner => (w === 'tie' ? 'tie' : c.a < c.b === (w === 'a') ? 'a' : 'b');
    if (!c.repeat) first.set(k, orient(c.winner));
    else if (first.has(k)) {
      of++;
      if (first.get(k) === orient(c.winner)) agree++;
    }
  }
  return { agree, of };
}
