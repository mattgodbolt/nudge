// Offline evaluation for LLM triage (issues #9, #10). Run with tsx; never imported by the server.
//
//   npm run eval:classify -- sample [--round N]      build the labelling set (round 2 and later: a fresh batch, N>1)
//   npm run eval:classify -- run --set scored        classify (asks to confirm the projected cost; add --yes)
//   npm run eval:classify -- score --labels data/eval/labels.json
//
// Needs ANTHROPIC_API_KEY (or ~/.nudge-eval-key, mode 600) for `run`. Input is the JSONL from scripts/triage-eval/export.mjs.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ClassifierError, PROMPT_VERSION, costMicros, createAnthropicClassifier } from './anthropic.js';
import { labelArtifactHtml, labelPageHtml } from './labelPage.js';
import { buildPairs, fitBradleyTerry, kendallTau, pairwiseAccuracy, selfConsistency } from './rank.js';
import type { Comparison } from './rank.js';
import { rankArtifactHtml } from './rankPage.js';
import { rng } from './sample.js';
import { applyRules } from './rules.js';
import { buildSample } from './sample.js';
import { score } from './score.js';
import type { Scored } from './score.js';
import { truthFor, weakTruth } from './truth.js';
import type { Classification, EvalItem, Usage, Verdict } from './types.js';

const DIR = 'data/eval';
const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : (process.argv[i + 1] ?? dflt);
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
const items = (): EvalItem[] => readJsonl<EvalItem>(arg('input', `${DIR}/items.jsonl`)!);

interface CacheRow {
  key: string;
  id: string;
  model: string;
  promptVersion: string;
  result: Classification;
  usage: Usage;
  costMicros: number;
}
// A prompt file (--prompt) is a prompt study: its results are cached under a hash of its text, never the default tag.
const systemOverride = (): string | undefined => {
  const f = arg('prompt');
  return f ? readFileSync(f, 'utf8') : undefined;
};
const promptTag = (): string => {
  const s = systemOverride();
  return s === undefined ? PROMPT_VERSION : `file:${createHash('sha256').update(s).digest('hex').slice(0, 8)}`;
};
/** Deterministic half-and-half split of labelled ids: tune prompts on dev, look at test only to report. */
const splitOf = (id: string): 'dev' | 'test' =>
  createHash('sha256').update(id).digest()[0]! % 2 === 0 ? 'dev' : 'test';
const inSplit = (id: string): boolean => {
  const w = arg('split', 'all');
  return w === 'all' || splitOf(id) === w;
};
const cachePath = `${DIR}/cache.jsonl`;
const cacheKey = (it: EvalItem, model: string): string =>
  createHash('sha256')
    .update(JSON.stringify([it.id, it.text, it.thread, it.github, model, promptTag()]))
    .digest('hex');
const loadCache = (): Map<string, CacheRow> =>
  new Map((existsSync(cachePath) ? readJsonl<CacheRow>(cachePath) : []).map((r) => [r.key, r]));

function loadHand(): Map<string, Verdict> {
  const path = arg('labels', `${DIR}/labels.json`)!;
  if (!existsSync(path)) return new Map();
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { verdict?: Verdict }>;
  return new Map(Object.entries(raw).flatMap(([id, l]) => (l.verdict ? [[id, l.verdict] as const] : [])));
}

/** Round 1 is label-sample.json; round N is label-sample-N.json. */
const roundFile = (n: number): string => `${DIR}/label-sample${n <= 1 ? '' : `-${n}`}.json`;
const idsIn = (file: string): string[] =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { item: EvalItem }[]).map((s) => s.item.id) : [];
const MAX_ROUNDS = 9;

/** A later round is a fresh, unseen batch for a held-out score: it never reuses an item from an earlier round. */
function cmdSample(): void {
  const round = Number(arg('round', '1'));
  const exclude = new Set<string>();
  for (let r = 1; r < round; r++) for (const id of idsIn(roundFile(r))) exclude.add(id);
  const sample = buildSample(items(), Number(arg('seed', String(round))), {
    exclude,
    scale: round > 1 ? 1.2 : 1,
  });
  writeFileSync(roundFile(round), JSON.stringify(sample, null, 1));
  if (round > 1) writeFileSync(`${DIR}/label-artifact-${round}.html`, labelArtifactHtml(sample, `labels${round}`));
  else writeFileSync(`${DIR}/label.html`, labelPageHtml(sample));
  const by = new Map<string, number>();
  for (const s of sample) by.set(s.stratum, (by.get(s.stratum) ?? 0) + 1);
  console.log(`${sample.length} items:`, Object.fromEntries(by));
  console.log(
    round > 1
      ? `Publish ${DIR}/label-artifact-${round}.html as an artifact; labels land in its "labels${round}" collection.`
      : `Open ${DIR}/label.html in a browser, label them, press "Download labels.json" and save it as ${DIR}/labels.json`,
  );
}

function targetSet(all: EvalItem[]): EvalItem[] {
  const which = arg('set', 'scored')!;
  if (which === 'all') return all;
  const round = /^sample(\d*)$/.exec(which);
  const sampleIds = new Set(idsIn(roundFile(round?.[1] ? Number(round[1]) : 1)));
  if (which === 'labelled') {
    // Every labelled round together, for studies that pool them.
    const every = new Set<string>();
    for (let r = 1; r <= MAX_ROUNDS; r++) for (const id of idsIn(roundFile(r))) every.add(id);
    return all.filter((i) => every.has(i.id));
  }
  if (round) return all.filter((i) => sampleIds.has(i.id));
  // scored: the sample plus everything the owner's own behaviour gives a weak label to (since 2025, to stay current).
  return all.filter((i) => sampleIds.has(i.id) || (weakTruth(i) !== null && i.occurredAt >= '2025-01-01'));
}

async function cmdRun(): Promise<void> {
  const model = arg('model', 'claude-haiku-5-5')!;
  const cache = loadCache();
  const todo = targetSet(items())
    .filter((i) => inSplit(i.id))
    .filter((i) => !cache.has(cacheKey(i, model)))
    .slice(0, Number(arg('limit', '1000000')));
  const per = model.includes('haiku') ? 340 : 6800;
  console.log(
    `${todo.length} items to classify with ${model}; projected cost about $${((todo.length * per) / 1e6).toFixed(2)}`,
  );
  if (todo.length === 0) return;
  if (!flag('yes')) return void console.log('Add --yes to spend it.');
  const keyFile = `${homedir()}/.nudge-eval-key`;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY or put a key (with a small spend limit) in ~/.nudge-eval-key');
  const clf = createAnthropicClassifier({ apiKey, model, system: systemOverride() });
  let done = 0;
  let failed = 0;
  let spent = 0;
  let fatal: ClassifierError | null = null;
  const worker = async (): Promise<void> => {
    for (let it = todo.shift(); it && !fatal; it = todo.shift()) {
      try {
        const { result, usage } = await clf.classify(it);
        const row: CacheRow = {
          key: cacheKey(it, model),
          id: it.id,
          model,
          promptVersion: promptTag(),
          result,
          usage,
          costMicros: costMicros(model, usage),
        };
        appendFileSync(cachePath, JSON.stringify(row) + '\n');
        spent += row.costMicros;
        done++;
      } catch (e) {
        failed++;
        if (e instanceof ClassifierError && e.fatal) fatal = e;
        else console.error(`  ${it.id}: ${e instanceof Error ? e.message : e}`);
      }
      if ((done + failed) % 25 === 0) console.log(`  ${done} done, ${failed} failed, $${(spent / 1e6).toFixed(3)}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`Finished: ${done} classified, ${failed} failed, $${(spent / 1e6).toFixed(3)} spent.`);
  if (fatal) throw fatal;
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

function cmdScore(): void {
  const model = arg('model', 'claude-haiku-5-5')!;
  const hand = loadHand();
  const cache = loadCache();
  const all = items();
  const configs: Record<string, (i: EvalItem) => Verdict | null> = {
    // Rules alone: a rule hit decides, everything else stays in the inbox (the safe default).
    'rules only': (i) => applyRules(i)?.verdict ?? 'needs_reply',
    'LLM only': (i) => cache.get(cacheKey(i, model))?.result.verdict ?? null,
    // A confident rule wins; otherwise the model.
    'rules, then LLM': (i) => {
      const r = applyRules(i);
      if (r && r.confidence !== 'low') return r.verdict;
      return cache.get(cacheKey(i, model))?.result.verdict ?? null;
    },
  };
  for (const [name, predict] of Object.entries(configs)) {
    for (const source of ['hand', 'weak'] as const) {
      const rows: Scored[] = [];
      for (const i of all) {
        const truth = truthFor(i, hand);
        const predicted = predict(i);
        if (truth?.source !== source || predicted === null || !inSplit(i.id)) continue;
        rows.push({
          id: i.id,
          truth,
          predicted,
          confidence: cache.get(cacheKey(i, model))?.result.confidence ?? 'high',
        });
      }
      const r = score(rows);
      console.log(`\n== ${name} vs ${source} labels (n=${r.n})`);
      console.log(
        `   needs_reply recall ${pct(r.needsReplyRecall)} (target >= 95%)   no_reply precision ${pct(r.noReplyPrecision)}   spam precision ${pct(r.spamPrecision)}`,
      );
      console.table(r.matrix);
      if (source === 'hand' && r.dangerous.length) {
        const byId = new Map(all.map((i) => [i.id, i]));
        console.log('   would have hidden something that needed a reply:');
        for (const id of r.dangerous.slice(0, 15)) console.log(`   - ${id}: ${byId.get(id)?.text.slice(0, 110)}`);
      }
    }
  }
  const rows = [...cache.values()].filter((r) => r.model === model && r.promptVersion === promptTag());
  const injected = rows.filter((r) => r.result.injectionAttempt);
  console.log(
    `\nCache: ${rows.length} results, $${(rows.reduce((s, r) => s + r.costMicros, 0) / 1e6).toFixed(3)} total, ${injected.length} flagged as injection attempts`,
  );
  for (const r of injected.slice(0, 10))
    console.log(`  injection? ${r.id}: ${all.find((i) => i.id === r.id)?.text.slice(0, 100)}`);
}

/**
 * Priority study (#27), step 1: pick the items worth ranking (things the owner wanted to see, from the labelled
 * rounds) and the comparisons to ask about, and build the page he answers them on.
 */
function cmdRankSample(): void {
  const nItems = Number(arg('items', '60'));
  const hand = JSON.parse(readFileSync(`${DIR}/labels-all.json`, 'utf8')) as Record<string, { verdict?: Verdict }>;
  const byId = new Map(items().map((i) => [i.id, i]));
  const rand = rng(Number(arg('seed', '1')));
  const shuffled = <T>(xs: T[]): T[] =>
    xs
      .map((x) => [rand(), x] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, x]) => x);
  const pool = (v: Verdict, gh: boolean): EvalItem[] =>
    shuffled(
      Object.entries(hand)
        .filter(([id, l]) => l.verdict === v && (byId.get(id)?.provider === 'github') === gh)
        .flatMap(([id]) => byId.get(id) ?? []),
    );
  // Bot "actions" are few but must compete with replies, so they get a fixed share.
  const chosen = [
    ...pool('needs_action', true).slice(0, Math.round(nItems * 0.13)),
    ...pool('needs_reply', true).slice(0, Math.round(nItems * 0.33)),
  ];
  chosen.push(...pool('needs_reply', false).slice(0, nItems - chosen.length));
  const pairs = buildPairs(
    chosen.map((i) => i.id),
    Number(arg('rounds', '6')),
    Number(arg('repeats', '15')),
    Number(arg('seed', '1')),
  );
  writeFileSync(`${DIR}/rank-set.json`, JSON.stringify({ items: chosen, pairs }, null, 1));
  writeFileSync(`${DIR}/rank-artifact.html`, rankArtifactHtml(chosen, pairs));
  console.log(`${chosen.length} items, ${pairs.length} comparisons (${pairs.filter((p) => p.repeat).length} repeats).`);
  console.log(`Publish ${DIR}/rank-artifact.html as an artifact; answers land in its "pairs" collection.`);
}

/**
 * Priority study, step 2: fit the owner's comparisons, report how consistent he is, and score candidate rankers
 * against them. `--comparisons` is a JSON array of {a, b, w: a|b|t, repeat?}; `--scores` an optional JSON map of
 * item id to a candidate's priority (higher matters more). Baselines are built in.
 */
function cmdRankScore(): void {
  const raw = JSON.parse(readFileSync(arg('comparisons', `${DIR}/rank-pairs.json`)!, 'utf8')) as {
    a: string;
    b: string;
    w: string;
    repeat?: boolean;
  }[];
  const all: (Comparison & { repeat?: boolean })[] = raw.map((r) => ({
    a: r.a,
    b: r.b,
    winner: r.w === 'a' ? 'a' : r.w === 'b' ? 'b' : 'tie',
    repeat: r.repeat,
  }));
  const byId = new Map(items().map((i) => [i.id, i]));
  const firsts = all.filter((c) => !c.repeat);
  const sc = selfConsistency(all);
  const ties = all.filter((c) => c.winner === 'tie').length;
  console.log(`${all.length} comparisons (${ties} ties). Self-consistency on re-asked pairs: ${sc.agree}/${sc.of}`);

  // Held out by pair so the fit and the check never share a comparison.
  const half = (c: Comparison, want: 'dev' | 'test'): boolean => splitOf(c.a + '|' + c.b) === want;
  const fit = fitBradleyTerry(firsts.filter((c) => half(c, 'dev')));
  const test = firsts.filter((c) => half(c, 'test'));
  const ref = pairwiseAccuracy(test, (i) => fit.get(i));
  console.log(
    `Fit on half the pairs predicts the other half: ${pct(ref.accuracy)} of ${ref.decided} (the ceiling for any ranker)`,
  );

  const full = fitBradleyTerry(firsts);
  const scorers: Record<string, Map<string, number>> = {
    recency: new Map([...full.keys()].map((i) => [i, Date.parse(byId.get(i)?.occurredAt ?? '0')])),
    'text length': new Map([...full.keys()].map((i) => [i, byId.get(i)?.text.length ?? 0])),
    'bot or PR first': new Map([...full.keys()].map((i) => [i, byId.get(i)?.github?.authorType === 'Bot' ? 1 : 0])),
  };
  const scoresFile = arg('scores');
  if (scoresFile) {
    const s = JSON.parse(readFileSync(scoresFile, 'utf8')) as Record<string, number>;
    scorers['candidate'] = new Map(Object.entries(s));
  }
  for (const [name, m] of Object.entries(scorers)) {
    const acc = pairwiseAccuracy(firsts, (i) => m.get(i));
    console.log(
      `  ${name.padEnd(16)} pairwise ${pct(acc.accuracy)} of ${acc.decided}   tau vs fit ${kendallTau(m, full)?.toFixed(2) ?? 'n/a'}`,
    );
  }
  console.log('  random           pairwise 50.0%');
  const top = [...full].sort((a, b) => b[1] - a[1]);
  const show = (label: string, xs: [string, number][]): void => {
    console.log(label);
    for (const [id] of xs) console.log(`   - ${byId.get(id)?.text.slice(0, 100) ?? id}`);
  };
  show('Most important (fit):', top.slice(0, 5));
  show('Least important (fit):', top.slice(-5));
}

const cmd = process.argv[2];
if (cmd === 'sample') cmdSample();
else if (cmd === 'run') await cmdRun();
else if (cmd === 'score') cmdScore();
else if (cmd === 'rank-sample') cmdRankSample();
else if (cmd === 'rank-score') cmdRankScore();
else
  console.log(
    'usage: eval:classify sample | run [--set sample|scored|all] [--model M] [--limit N] [--yes] | score [--labels file]',
  );
