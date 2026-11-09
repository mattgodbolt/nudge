// Offline evaluation for LLM triage (issues #9, #10). Run with tsx; never imported by the server.
//
//   npm run eval:classify -- sample [--round 2]      build data/eval/label-sample.json and label.html (round 2: a fresh batch)
//   npm run eval:classify -- run --set scored        classify (asks to confirm the projected cost; add --yes)
//   npm run eval:classify -- score --labels data/eval/labels.json
//
// Needs ANTHROPIC_API_KEY (or ~/.nudge-eval-key, mode 600) for `run`. Input is the JSONL from scripts/triage-eval/export.mjs.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ClassifierError, PROMPT_VERSION, costMicros, createAnthropicClassifier } from './anthropic.js';
import { labelArtifactHtml, labelPageHtml } from './labelPage.js';
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

/** Round 2 is a fresh, unseen batch for the final held-out score: it never reuses a round-1 item. */
function cmdSample(): void {
  const round2 = arg('round') === '2';
  const first = `${DIR}/label-sample.json`;
  const exclude = new Set(
    round2 ? (JSON.parse(readFileSync(first, 'utf8')) as { item: EvalItem }[]).map((s) => s.item.id) : [],
  );
  const sample = buildSample(items(), Number(arg('seed', round2 ? '2' : '1')), {
    exclude,
    scale: round2 ? 1.2 : 1,
  });
  if (round2) {
    writeFileSync(`${DIR}/label-sample-2.json`, JSON.stringify(sample, null, 1));
    writeFileSync(`${DIR}/label-artifact-2.html`, labelArtifactHtml(sample, 'labels2'));
  } else {
    writeFileSync(first, JSON.stringify(sample, null, 1));
    writeFileSync(`${DIR}/label.html`, labelPageHtml(sample));
  }
  const by = new Map<string, number>();
  for (const s of sample) by.set(s.stratum, (by.get(s.stratum) ?? 0) + 1);
  console.log(`${sample.length} items:`, Object.fromEntries(by));
  console.log(
    `Open ${DIR}/label.html in a browser, label them, press "Download labels.json" and save it as ${DIR}/labels.json`,
  );
}

function targetSet(all: EvalItem[]): EvalItem[] {
  const which = arg('set', 'scored');
  if (which === 'all') return all;
  const file = `${DIR}/label-sample${which === 'sample2' ? '-2' : ''}.json`;
  const sampleIds = new Set(
    existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { item: EvalItem }[]).map((s) => s.item.id) : [],
  );
  if (which === 'sample' || which === 'sample2') return all.filter((i) => sampleIds.has(i.id));
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

const cmd = process.argv[2];
if (cmd === 'sample') cmdSample();
else if (cmd === 'run') await cmdRun();
else if (cmd === 'score') cmdScore();
else
  console.log(
    'usage: eval:classify sample | run [--set sample|scored|all] [--model M] [--limit N] [--yes] | score [--labels file]',
  );
