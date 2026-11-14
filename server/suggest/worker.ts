import { createHash } from 'node:crypto';
import type { EventBus, Repo } from '../contracts.js';
import { applyRules, type RuleHit } from '../classify/rules.js';
import {
  PROMPT_VERSION,
  ClassifierError,
  costMicros,
  createAnthropicClassifier,
  renderItem,
} from '../classify/anthropic.js';
import type { Classifier } from '../classify/anthropic.js';
import type { EvalItem } from '../classify/types.js';

/** Hard ceiling on estimated spend per UTC day. A constant on purpose: a runaway loop must not be fixable by a setting. */
export const DAILY_CAP_USD = 2;
const CONCURRENCY = 2;
/** Most items one pass classifies, newest first; the rest wait for the next start or arrival. */
const PASS_CAP = 200;
/** Most inbox rows one pass looks at while hunting for ones whose suggestion is missing or stale. */
const SCAN = 2000;
const NOTIFY_DEBOUNCE_MS = 1500;
const START_DELAY_MS = 3000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

/** Why a deterministic rule decided, in the plain sentence shown to the owner. */
const RULE_REASONS: Record<string, string> = {
  'ghost-empty': 'Empty item from a deleted account',
  'github-bot-author': 'Automated pull request or notice from a bot',
  'symbol-soup': 'A string of meaningless symbols',
  'no-words': 'Only emoji or symbols, no words',
  'spammy-keywords': 'Mentions crypto, messaging apps or investment',
};

/**
 * Fingerprint of what the model is shown: the prompt version and the rendered item (which carries the text, thread
 * context and GitHub comment count). Any change to either is a reason to ask again; nothing else is.
 */
export function stateKey(item: EvalItem): string {
  return createHash('sha256')
    .update(`${PROMPT_VERSION}\n${renderItem(item)}`)
    .digest('hex')
    .slice(0, 32);
}

export interface SuggestWorkerDeps {
  repo: Repo;
  bus: EventBus;
  /** Default: the key in settings. Null means "do nothing at all". */
  getApiKey?: () => string | null;
  /** Default: the real Anthropic classifier. Tests and demo mode pass a fake; nothing here ever reaches the network otherwise. */
  makeClassifier?: (apiKey: string, model: string) => Classifier;
  now?: () => Date;
  log?: (msg: string, err?: unknown) => void;
  dailyCapUsd?: number;
  concurrency?: number;
  passCap?: number;
  debounceMs?: number;
  startDelayMs?: number;
  backoffBaseMs?: number;
}

export interface PassResult {
  /** Suggestions written (by a rule or by the model). */
  saved: number;
  /** Of those, how many needed a model call. */
  modelCalls: number;
  /** Set when the pass ended early: 'no-key' | 'key-rejected' | 'backoff' | 'cap' | 'error'. */
  stopped?: string;
}

export interface SuggestWorker {
  start(): void;
  stop(): void;
  /** Items may have arrived or changed: look at them soon. */
  notify(ids: string[]): void;
  /** Look at the whole inbox soon (the key or model may just have been set). */
  kick(): void;
  /** One pass now: the given items, or every inbox item (newest first, capped) when `ids` is omitted. */
  runOnce(ids?: string[]): Promise<PassResult>;
  /** Resolves when no pass is running (tests). */
  idle(): Promise<void>;
}

/**
 * Background classifier that attaches an advisory suggestion to inbox items. It only ever writes the suggestions
 * table and announces it on the bus: it never touches an item's state, and nothing in a request path waits for it or
 * can be failed by it. Item text is untrusted data: it reaches the model entity-escaped through the same renderItem
 * the eval measured, and an item the model says tried to instruct it is stored as suspicious and shown with no action.
 */
export function createSuggestWorker(deps: SuggestWorkerDeps): SuggestWorker {
  const { repo, bus } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m, e) => console.warn(`suggestions: ${m}`, e instanceof Error ? e.message : (e ?? '')));
  const getApiKey = deps.getApiKey ?? (() => repo.getSettings().llm.apiKey);
  const makeClassifier = deps.makeClassifier ?? ((apiKey, model) => createAnthropicClassifier({ apiKey, model }));
  const cap = deps.dailyCapUsd ?? DAILY_CAP_USD;
  const concurrency = deps.concurrency ?? CONCURRENCY;
  const passCap = deps.passCap ?? PASS_CAP;
  const debounceMs = deps.debounceMs ?? NOTIFY_DEBOUNCE_MS;
  const backoffBase = deps.backoffBaseMs ?? BACKOFF_BASE_MS;

  const pending = new Set<string>();
  let backfillWanted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let stopped = false;
  let running: Promise<void> | null = null;
  let rerun = false;
  let backoffUntil = 0;
  let backoffStep = 0;
  let rejectedKey: string | null = null;
  let capLoggedFor = '';
  /** Spend this process has made today, in case replacing a suggestion row dropped an earlier cost from the table. */
  let memSpend = { day: '', usd: 0 };
  /** Items the model answered badly for, by the fingerprint it failed on: not retried until the item changes. */
  const failed = new Map<string, string>();

  const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
  const dayStart = (d: Date): string => `${dayOf(d)}T00:00:00.000Z`;
  function spentToday(): number {
    const d = now();
    const table = repo.suggestions.spentSince(dayStart(d));
    return Math.max(table, memSpend.day === dayOf(d) ? memSpend.usd : 0);
  }
  function addSpend(usd: number): void {
    const day = dayOf(now());
    memSpend = memSpend.day === day ? { day, usd: memSpend.usd + usd } : { day, usd };
  }

  function schedule(ms: number): void {
    if (stopped) return;
    clearTimeout(timer);
    // Never wake inside a pause: a notification during a back-off must not cut it short.
    const wait = Math.max(ms, backoffUntil - now().getTime() + 50, 0);
    timer = setTimeout(() => void drain(), wait);
    timer.unref?.();
  }

  function pause(ms: number): void {
    backoffUntil = now().getTime() + ms;
    schedule(ms + 50);
  }

  async function classifyOne(
    clf: Classifier,
    item: EvalItem,
    key: string,
    rule: RuleHit | null,
  ): Promise<'saved' | 'model'> {
    const at = now().toISOString();
    if (rule) {
      repo.suggestions.save({
        itemId: item.id,
        stateKey: key,
        verdict: rule.verdict,
        category: rule.category,
        confidence: rule.confidence,
        reason: RULE_REASONS[rule.rule] ?? 'Decided by a simple rule',
        injectionAttempt: false,
        model: 'rules',
        promptVersion: `rule:${rule.rule}`,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        createdAt: at,
      });
      return 'saved';
    }
    const { result, usage } = await clf.classify(item);
    const costUsd = costMicros(clf.model, usage) / 1e6;
    addSpend(costUsd);
    repo.suggestions.save({
      itemId: item.id,
      stateKey: key,
      verdict: result.verdict,
      category: result.category,
      confidence: result.confidence,
      reason: result.reason,
      injectionAttempt: result.injectionAttempt,
      model: clf.model,
      promptVersion: PROMPT_VERSION,
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      createdAt: at,
    });
    return 'model';
  }

  async function pass(ids?: string[]): Promise<PassResult> {
    const out: PassResult = { saved: 0, modelCalls: 0 };
    const apiKey = getApiKey();
    if (!apiKey) return { ...out, stopped: 'no-key' };
    if (rejectedKey === apiKey) return { ...out, stopped: 'key-rejected' };
    if (now().getTime() < backoffUntil) return { ...out, stopped: 'backoff' };

    const settings = repo.getSettings();
    const mine = new Set(settings.github.myAccounts.map((l) => l.toLowerCase()));
    const cands = repo.suggestions.candidates({
      ...(ids ? { ids } : {}),
      scan: ids ? ids.length : SCAN,
      myLogins: mine,
    });
    const work: { item: EvalItem; key: string }[] = [];
    for (const c of cands) {
      const key = stateKey(c.item);
      if (c.storedKey === key || failed.get(c.item.id) === key) continue;
      work.push({ item: c.item, key });
      if (work.length >= passCap) break;
    }
    if (work.length === 0) return out;

    const clf = makeClassifier(apiKey, settings.llm.model);
    let next = 0;
    let halt: string | undefined;
    async function lane(): Promise<void> {
      while (!halt && !stopped) {
        const w = work[next++];
        if (!w) return;
        const rule = applyRules(w.item);
        if (!rule && spentToday() >= cap) {
          halt = 'cap';
          const day = dayOf(now());
          if (capLoggedFor !== day) {
            capLoggedFor = day;
            log(`daily cap of $${cap} reached; pausing until tomorrow (UTC)`);
          }
          const midnight = Date.parse(dayStart(now())) + DAY_MS;
          pause(midnight - now().getTime());
          return;
        }
        try {
          const how = await classifyOne(clf, w.item, w.key, rule);
          out.saved++;
          if (how === 'model') out.modelCalls++;
          backoffStep = 0;
          const dto = repo.suggestions.get([w.item.id]).get(w.item.id) ?? null;
          bus.emit({ type: 'suggestions.changed', suggestions: { [w.item.id]: dto } });
        } catch (e) {
          const status = e instanceof ClassifierError ? e.status : undefined;
          if (status === 401 || status === 403) {
            rejectedKey = apiKey;
            halt = 'key-rejected';
            log('the API key was rejected; suggestions are off until the key changes');
          } else if (
            e instanceof ClassifierError &&
            (status === 429 || (status ?? 0) >= 500 || e.message.startsWith('network'))
          ) {
            // Rate limit, server trouble or no network: the classifier already retried, so give it a long rest.
            const wait = Math.min(backoffBase * 2 ** backoffStep++, BACKOFF_MAX_MS);
            halt = 'backoff';
            log(`${e.message}; pausing ${Math.round(wait / 1000)}s`);
            pause(wait);
          } else {
            // This one item cannot be classified (bad request, off-schema answer): skip it until it changes.
            failed.set(w.item.id, w.key);
            log(`could not classify ${w.item.id}`, e);
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
    if (halt) out.stopped = halt;
    return out;
  }

  async function runOnce(ids?: string[]): Promise<PassResult> {
    try {
      return await pass(ids);
    } catch (e) {
      log('pass failed', e);
      return { saved: 0, modelCalls: 0, stopped: 'error' };
    }
  }

  async function drain(): Promise<void> {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = (async () => {
      do {
        rerun = false;
        const all = backfillWanted;
        backfillWanted = false;
        const ids = [...pending];
        pending.clear();
        const res = all ? await runOnce() : ids.length > 0 ? await runOnce(ids) : null;
        // A pause dropped the work it interrupted: look at everything again when it ends.
        if (res?.stopped === 'backoff' || res?.stopped === 'cap') backfillWanted = true;
      } while (rerun && !stopped);
    })().finally(() => {
      running = null;
    });
    await running;
  }

  return {
    start() {
      stopped = false;
      unsubscribe = bus.subscribe((e) => {
        if (e.type !== 'inbox.changed') return;
        const ids = [...e.addedIds, ...e.changedIds];
        if (ids.length > 0) this.notify(ids);
      });
      backfillWanted = true;
      schedule(deps.startDelayMs ?? START_DELAY_MS);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      unsubscribe?.();
    },
    kick() {
      if (stopped || !getApiKey()) return;
      backfillWanted = true;
      schedule(debounceMs);
    },
    notify(ids) {
      if (stopped || !getApiKey()) return;
      for (const id of ids) pending.add(id);
      schedule(debounceMs);
    },
    runOnce,
    async idle() {
      while (running) await running;
    },
  };
}
