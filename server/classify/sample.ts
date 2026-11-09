import type { EvalItem } from './types.js';

/** Small deterministic PRNG (mulberry32), so a sample is reproducible and a re-run does not reshuffle the labels. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function take<T>(xs: T[], n: number, rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/** Strata for the hand-labelled set. Quotas are targets: a thin stratum just gives what it has. */
const STRATA: { name: string; quota: number; match: (i: EvalItem) => boolean }[] = [
  {
    name: 'yt-done-by-owner',
    quota: 25,
    match: (i) => i.provider === 'youtube' && i.state === 'done' && i.stateSource === 'user',
  },
  {
    name: 'yt-answered-recent',
    quota: 25,
    match: (i) => i.provider === 'youtube' && !!i.ownReply && i.occurredAt >= '2025-01-01',
  },
  {
    name: 'yt-question-unanswered',
    quota: 20,
    match: (i) =>
      i.provider === 'youtube' &&
      !i.ownReply &&
      i.text.includes('?') &&
      i.occurredAt >= '2025-01-01' &&
      i.state === 'archived',
  },
  {
    name: 'yt-plain-unanswered',
    quota: 25,
    match: (i) =>
      i.provider === 'youtube' &&
      !i.ownReply &&
      !i.text.includes('?') &&
      i.occurredAt >= '2025-01-01' &&
      i.state === 'archived',
  },
  {
    name: 'yt-spammy',
    quota: 6,
    match: (i) => i.provider === 'youtube' && /telegram|whatsapp|bitcoin|crypto(?!graph)|t\.me\//i.test(i.text),
  },
  {
    name: 'gh-human-inbox',
    quota: 12,
    match: (i) => i.provider === 'github' && i.github?.authorType !== 'Bot' && i.state === 'inbox',
  },
  {
    name: 'gh-human-done',
    quota: 8,
    match: (i) => i.provider === 'github' && i.github?.authorType !== 'Bot' && i.state === 'done',
  },
  { name: 'gh-bot', quota: 6, match: (i) => i.provider === 'github' && i.github?.authorType === 'Bot' },
];

/**
 * `exclude` keeps a later round from reusing already-labelled ids; `scale` stretches every quota (a thin stratum still
 * just gives what it has).
 */
export function buildSample(
  items: EvalItem[],
  seed = 1,
  opts: { exclude?: ReadonlySet<string>; scale?: number } = {},
): { stratum: string; item: EvalItem }[] {
  const rand = rng(seed);
  const used = new Set<string>(opts.exclude);
  const out: { stratum: string; item: EvalItem }[] = [];
  for (const s of STRATA) {
    for (const item of take(
      items.filter((i) => s.match(i) && !used.has(i.id)),
      Math.round(s.quota * (opts.scale ?? 1)),
      rand,
    )) {
      used.add(item.id);
      out.push({ stratum: s.name, item });
    }
  }
  // Mixed order so the labeller cannot guess a stratum from the run of items.
  return take(out, out.length, rand);
}
