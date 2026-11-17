import { createHash } from 'node:crypto';
import { GithubError } from '../contracts.js';
import type { EventBus, GithubClient, Repo } from '../contracts.js';
import type { SuggestStatusDTO } from '../../shared/types.js';
import { ownerProfileComplete, type OwnerProfile } from '../../shared/owner.js';
import type { RecentComment, SuggestionCandidate } from '../db/suggestions.js';
import { applyRules, type RuleHit } from '../classify/rules.js';
import {
  PROMPT_VERSION,
  RECENT_TEXT,
  ClassifierError,
  costMicros,
  createAnthropicClassifier,
  renderItem,
} from '../classify/anthropic.js';
import type { Classifier } from '../classify/anthropic.js';
import type { EvalItem } from '../classify/types.js';

/**
 * Hard ceiling on estimated spend per UTC day, across suggestions, the snooze calls and the assistant (the ledger in
 * db/spend.ts). A constant on purpose: a runaway loop must not be fixable by a setting.
 */
export const DAILY_CAP_USD = 2;

/** Has today's model spend, from every caller, reached the cap? */
export function overDailyCap(repo: Pick<Repo, 'spend'>, cap: number = DAILY_CAP_USD): boolean {
  return repo.spend.todayUsd() >= cap;
}
const CONCURRENCY = 2;
/**
 * Most items one pass classifies. A drain runs passes back to back until a pass finds nothing left to do, so this only
 * bounds how long one pass holds its work list (and how often progress is logged), not how much gets classified.
 */
const PASS_CAP = 200;
/** Most inbox rows one pass looks at while hunting for ones whose suggestion is missing or stale. */
const SCAN = 10_000;
/** A runaway guard on passes in one drain: 200 passes of 200 is 40,000 items. */
const MAX_PASSES = 200;
/**
 * Thread excerpts are only fetched while GitHub's REST budget has at least this much left, so the poller, the item
 * detail view and the owner's own use of the token always keep a reserve (the budget is 5,000 an hour).
 */
const RATE_FLOOR = 1000;
/** Wait this long past GitHub's stated reset before using the budget again (clock skew). */
const RESET_SLACK_MS = 5000;
const STATUS_THROTTLE_MS = 1500;
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

/** Recent comments fetched per GitHub item, and how long a failed fetch is left alone before it is tried again. */
const RECENT_LIMIT = 4;
const FETCH_RETRY_MS = 15 * 60_000;

/**
 * Fingerprint of what the model is shown: the prompt version, the owner's profile and standing notes (by hash) and the
 * rendered item (which carries the text, thread context, GitHub comment count, the recent comments, a snooze note and
 * any note about the item). Any change to any of them is a reason to ask again; nothing else is.
 */
export function stateKey(item: EvalItem, notesHash = '', ownerHash = ''): string {
  return createHash('sha256')
    .update(`${PROMPT_VERSION}\n${ownerHash}\n${notesHash}\n${renderItem(item)}`)
    .digest('hex')
    .slice(0, 32);
}

/** The profile as the prompt sees it, hashed: editing Settings > About you asks the model again. */
export const ownerHash = (owner: OwnerProfile): string =>
  createHash('sha256')
    .update(JSON.stringify([owner.name.trim(), owner.about.trim()]))
    .digest('hex')
    .slice(0, 16);

export interface SuggestWorkerDeps {
  repo: Repo;
  bus: EventBus;
  /**
   * Where the last few comments of a GitHub item come from. Without it (or for an item whose comments cannot be
   * fetched) the suggestion is made from what is already stored, as before.
   */
  githubClient?: Pick<GithubClient, 'recentComments' | 'coreRate'>;
  /** Default: the key in settings. Null means "do nothing at all". */
  getApiKey?: () => string | null;
  /** Default: Settings > About you. Incomplete means "do nothing at all", as with no key: the prompt needs it. */
  getOwner?: () => OwnerProfile;
  /** Default: the real Anthropic classifier. Tests and demo mode pass a fake; nothing here ever reaches the network otherwise. */
  makeClassifier?: (apiKey: string, model: string, owner: OwnerProfile) => Classifier;
  now?: () => Date;
  log?: (msg: string, err?: unknown) => void;
  dailyCapUsd?: number;
  concurrency?: number;
  passCap?: number;
  /** Stop fetching GitHub threads when fewer than this many REST requests remain (default 1000). */
  rateFloor?: number;
  debounceMs?: number;
  startDelayMs?: number;
  backoffBaseMs?: number;
}

export interface PassResult {
  /** Suggestions written (by a rule or by the model). */
  saved: number;
  /** Of those, how many needed a model call. */
  modelCalls: number;
  /** Set when the pass ended early: 'no-key' | 'no-profile' | 'key-rejected' | 'backoff' | 'cap' | 'error'. */
  stopped?: string;
  /** Items it got as far as classifying (or trying to): zero means there was nothing left to do. */
  attempted: number;
  /** Items held back because GitHub's rate limit forbids fetching their thread right now. */
  deferred: number;
}

export interface SuggestWorker {
  start(): void;
  stop(): void;
  /** Items may have arrived or changed: look at them soon. */
  notify(ids: string[]): void;
  /** Look at the whole inbox soon (the key or model may just have been set). */
  kick(): void;
  /** One pass now (at most `passCap` items): the given items, or every inbox item when `ids` is omitted. */
  runOnce(ids?: string[]): Promise<PassResult>;
  /** Resolves when no pass is running (tests). */
  idle(): Promise<void>;
  /** Progress through the inbox, and why it is waiting if it is. */
  status(): SuggestStatusDTO;
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
  const getOwner = deps.getOwner ?? (() => repo.getSettings().owner);
  const hasProfile = (): boolean => ownerProfileComplete(getOwner());
  const makeClassifier =
    deps.makeClassifier ?? ((apiKey, model, owner) => createAnthropicClassifier({ apiKey, model, owner }));
  const cap = deps.dailyCapUsd ?? DAILY_CAP_USD;
  const concurrency = deps.concurrency ?? CONCURRENCY;
  const passCap = deps.passCap ?? PASS_CAP;
  const rateFloor = deps.rateFloor ?? RATE_FLOOR;
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
  /** The missing profile is said once per process: the worker is asked to run on every inbox change. */
  let noProfileLogged = false;
  /** Items the model answered badly for, by the fingerprint it failed on: not retried until the item changes. */
  const failed = new Map<string, string>();
  /** Recent comments fetched in this process (also kept in the suggestion row once it is saved). */
  const threads = new Map<string, { recent: RecentComment[]; count: number }>();
  const fetchFailed = new Map<string, { count: number; at: number }>();
  /** GitHub told us (429 / secondary limit) not to call again before this time, epoch ms. */
  let ghBlockedUntil = 0;
  /** Items held back from classification until GitHub lets their thread be fetched. */
  let deferred = new Set<string>();
  let paused: SuggestStatusDTO['paused'] = null;
  let lastStatusAt = 0;
  let lastStatusJson = '';

  const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
  const dayStart = (d: Date): string => `${dayOf(d)}T00:00:00.000Z`;
  /** Today's spend from the shared ledger: suggestions, the snooze calls and the assistant all draw on one cap. */
  const spentToday = (): number => repo.spend.todayUsd();

  /**
   * When thread fetches may resume (epoch ms), or 0 if they may go ahead now: GitHub said wait, or the last response
   * reported less than the floor remaining and the reset is still ahead.
   */
  function githubBlockedUntil(): number {
    const t = now().getTime();
    let until = ghBlockedUntil > t ? ghBlockedUntil : 0;
    const r = deps.githubClient?.coreRate?.() ?? null;
    if (r && r.remaining < rateFloor) {
      const reset = Date.parse(r.resetAt);
      if (Number.isFinite(reset) && reset + RESET_SLACK_MS > t) until = Math.max(until, reset + RESET_SLACK_MS);
    }
    return until;
  }

  function status(): SuggestStatusDTO {
    const enabled = !!getApiKey();
    const { total, done } = repo.suggestions.progress(PROMPT_VERSION);
    let p = paused;
    if (p && p.until && Date.parse(p.until) <= now().getTime()) p = null;
    // After a restart the pause is not remembered, but the day's spend is: the cap is still what is holding it back.
    if (!p && enabled && done < total && spentToday() >= cap) {
      p = { reason: 'cap', until: new Date(Date.parse(dayStart(now())) + DAY_MS).toISOString() };
    }
    if (!p && rejectedKey !== null && rejectedKey === getApiKey()) p = { reason: 'key-rejected', until: null };
    if (enabled && !hasProfile()) p = { reason: 'no-profile', until: null };
    return {
      enabled,
      total,
      done,
      working: running !== null,
      paused: enabled ? p : null,
      waitingForThread: deferred.size,
    };
  }

  /** Tell the browsers how far along we are; throttled, and silent when nothing changed. */
  function emitStatus(force = false): void {
    const t = now().getTime();
    if (!force && t - lastStatusAt < STATUS_THROTTLE_MS) return;
    lastStatusAt = t;
    try {
      const st = status();
      const json = JSON.stringify(st);
      if (json === lastStatusJson) return;
      lastStatusJson = json;
      bus.emit({ type: 'suggestions.status', status: st });
    } catch {
      /* status is a courtesy: it must never break classification */
    }
  }

  function schedule(ms: number): void {
    if (stopped) return;
    clearTimeout(timer);
    // Never wake inside a pause: a notification during a back-off must not cut it short.
    const wait = Math.max(ms, backoffUntil - now().getTime() + 50, 0);
    timer = setTimeout(() => void drain().catch((e) => log('background run failed', e)), wait);
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
    notes: string[],
    thread: { recent: RecentComment[]; count: number } | null,
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
    const { result, usage } = await clf.classify(item, notes);
    const micros = costMicros(clf.model, usage);
    repo.spend.add('suggest', micros);
    const costUsd = micros / 1e6;
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
      turn: result.turn,
      nextStep: result.nextStep,
      thread: thread?.recent ?? null,
      threadCount: thread?.count ?? null,
    });
    return 'model';
  }

  interface Work {
    cand: SuggestionCandidate;
    item: EvalItem;
    /** Null until the recent comments have been fetched. */
    key: string | null;
    rule: RuleHit | null;
    thread: { recent: RecentComment[]; count: number } | null;
    fetchIt: boolean;
  }

  const withRecent = (item: EvalItem, recent: RecentComment[]): EvalItem =>
    item.github && recent.length > 0 ? { ...item, github: { ...item.github, recent } } : item;

  /** The recent comments already in hand for the item at its current comment count: stored, or fetched this run. */
  function excerptOf(c: SuggestionCandidate): { recent: RecentComment[]; count: number } | null {
    const comments = c.item.github?.comments ?? 0;
    if (!c.target) return null;
    if (c.storedThread && c.storedThread.count === comments) return c.storedThread;
    const m = threads.get(c.item.id);
    return m && m.count === comments ? m : null;
  }

  const recentlyFailed = (c: SuggestionCandidate): boolean => {
    const f = fetchFailed.get(c.item.id);
    return !!f && f.count === (c.item.github?.comments ?? 0) && now().getTime() - f.at < FETCH_RETRY_MS;
  };

  /**
   * One capped GitHub call for one item. Never throws. 'blocked' means GitHub's rate limit stopped it: the item is held
   * back, not classified blind (it would cost a second model call to redo once the thread is available, and a
   * suggestion about whose turn it is, made without the thread, is the one most likely to be wrong). Any other failure
   * classifies the item without its thread, as before.
   */
  async function fetchThread(w: Work, mine: Set<string>, token: string | null): Promise<'ok' | 'failed' | 'blocked'> {
    const c = w.cand;
    const comments = c.item.github?.comments ?? 0;
    try {
      if (!deps.githubClient || !c.target) throw new Error('no GitHub client');
      const got = await deps.githubClient.recentComments(c.target.repo, c.target.number, comments, token, RECENT_LIMIT);
      const recent = got.slice(-RECENT_LIMIT).map((g) => ({
        author: g.author,
        isOwner: mine.has(g.author.toLowerCase()),
        text: g.text.replace(/\s+/g, ' ').trim().slice(0, RECENT_TEXT),
      }));
      w.thread = { recent, count: comments };
      threads.set(c.item.id, w.thread);
      w.item = withRecent(c.item, recent);
      return 'ok';
    } catch (e) {
      if (e instanceof GithubError && e.retryAt) {
        const at = Date.parse(e.retryAt);
        ghBlockedUntil = Math.max(ghBlockedUntil, Number.isFinite(at) ? at + RESET_SLACK_MS : now().getTime() + 60_000);
        return 'blocked';
      }
      fetchFailed.set(c.item.id, { count: comments, at: now().getTime() });
      if (deps.githubClient) log(`could not fetch comments for ${c.item.id}`, e);
      return 'failed';
    }
  }

  async function pass(ids?: string[]): Promise<PassResult> {
    const out: PassResult = { saved: 0, modelCalls: 0, attempted: 0, deferred: 0 };
    if (paused?.until && Date.parse(paused.until) <= now().getTime()) paused = null;
    const apiKey = getApiKey();
    if (!apiKey) return { ...out, stopped: 'no-key' };
    const owner = getOwner();
    if (!ownerProfileComplete(owner)) {
      // Refuse rather than guess who the inbox belongs to: no prompt is built and nothing is spent.
      if (!noProfileLogged) {
        noProfileLogged = true;
        log('paused: Settings > About you needs a name and a description before the model is asked anything');
      }
      return { ...out, stopped: 'no-profile' };
    }
    if (rejectedKey === apiKey) return { ...out, stopped: 'key-rejected' };
    if (now().getTime() < backoffUntil) return { ...out, stopped: 'backoff' };

    const settings = repo.getSettings();
    const mine = new Set(settings.github.myAccounts.map((l) => l.toLowerCase()));
    const notes = repo.notes.standing();
    const who = ownerHash(owner);
    const cands = repo.suggestions.candidates({
      ...(ids ? { ids } : {}),
      scan: ids ? ids.length : SCAN,
      myLogins: mine,
    });
    const work: Work[] = [];
    const heldBack = new Set<string>();
    for (const c of cands) {
      const rule = applyRules(c.item);
      const have = rule ? null : excerptOf(c);
      // Only an item with a thread nobody has read yet needs the GitHub call; its key is made once it is fetched.
      const fetchIt = !rule && !have && c.target !== undefined && !recentlyFailed(c);
      // Out of GitHub budget: leave it for after the reset, and keep going with the items that need no fetch.
      if (fetchIt && githubBlockedUntil() > 0) {
        heldBack.add(c.item.id);
        continue;
      }
      const item = have ? withRecent(c.item, have.recent) : c.item;
      const key = fetchIt ? null : stateKey(item, notes.hash, who);
      if (key !== null && (c.storedKey === key || failed.get(c.item.id) === key)) continue;
      work.push({ cand: c, item, key, rule, thread: have, fetchIt });
      if (work.length >= passCap) break;
    }
    const finish = (): PassResult => {
      out.deferred = heldBack.size;
      if (ids) {
        for (const id of ids) deferred.delete(id);
        for (const id of heldBack) deferred.add(id);
      } else deferred = heldBack;
      return out;
    };
    if (work.length === 0) return finish();

    const clf = makeClassifier(apiKey, settings.llm.model, owner);
    let next = 0;
    let halt: string | undefined;
    async function lane(): Promise<void> {
      while (!halt && !stopped) {
        const w = work[next++];
        if (!w) return;
        const rule = w.rule;
        if (!rule && spentToday() >= cap) {
          halt = 'cap';
          const day = dayOf(now());
          if (capLoggedFor !== day) {
            capLoggedFor = day;
            log(`daily cap of $${cap} reached; pausing until tomorrow (UTC)`);
          }
          const midnight = Date.parse(dayStart(now())) + DAY_MS;
          paused = { reason: 'cap', until: new Date(midnight).toISOString() };
          pause(midnight - now().getTime());
          return;
        }
        try {
          if (w.fetchIt) {
            if (githubBlockedUntil() > 0) {
              heldBack.add(w.item.id);
              continue;
            }
            if ((await fetchThread(w, mine, settings.github.token)) === 'blocked') {
              heldBack.add(w.item.id);
              continue;
            }
            w.key = stateKey(w.item, notes.hash, who);
            if (w.cand.storedKey === w.key || failed.get(w.item.id) === w.key) {
              out.attempted++; // the fetch was the work: the next pass sees this item as settled
              continue;
            }
          }
          out.attempted++;
          const how = await classifyOne(clf, w.item, w.key!, rule, notes.texts, w.thread);
          out.saved++;
          if (how === 'model') out.modelCalls++;
          backoffStep = 0;
          paused = null;
          const dto = repo.suggestions.get([w.item.id]).get(w.item.id) ?? null;
          bus.emit({ type: 'suggestions.changed', suggestions: { [w.item.id]: dto } });
          emitStatus();
        } catch (e) {
          // An answer that could not be used was still billed: the cap must see it, or bad answers would be free.
          if (e instanceof ClassifierError && e.usage) repo.spend.add('suggest', costMicros(clf.model, e.usage));
          const status = e instanceof ClassifierError ? e.status : undefined;
          if (status === 401 || status === 403) {
            rejectedKey = apiKey;
            halt = 'key-rejected';
            paused = { reason: 'key-rejected', until: null };
            log('the API key was rejected; suggestions are off until the key changes');
          } else if (
            e instanceof ClassifierError &&
            (status === 429 || (status ?? 0) >= 500 || e.message.startsWith('network'))
          ) {
            // Rate limit, server trouble or no network: the classifier already retried, so give it a long rest.
            const wait = Math.min(backoffBase * 2 ** backoffStep++, BACKOFF_MAX_MS);
            halt = 'backoff';
            paused = { reason: 'backoff', until: new Date(now().getTime() + wait).toISOString() };
            log(`${e.message}; pausing ${Math.round(wait / 1000)}s`);
            pause(wait);
          } else {
            // This one item cannot be classified (bad request, off-schema answer): skip it until it changes.
            failed.set(w.item.id, w.key!);
            log(`could not classify ${w.item.id}`, e);
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
    if (halt) out.stopped = halt;
    return finish();
  }

  async function runOnce(ids?: string[]): Promise<PassResult> {
    try {
      return await pass(ids);
    } catch (e) {
      log('pass failed', e);
      return { saved: 0, modelCalls: 0, attempted: 0, deferred: 0, stopped: 'error' };
    }
  }

  /**
   * Passes back to back until one finds nothing to do, something stops it (cap, back-off, key) or only items that
   * wait on GitHub's rate limit are left. Progress is logged once per pass.
   */
  async function runUntilDone(ids?: string[]): Promise<PassResult> {
    const total: PassResult = { saved: 0, modelCalls: 0, attempted: 0, deferred: 0 };
    for (let n = 1; n <= MAX_PASSES && !stopped; n++) {
      const res = await runOnce(ids);
      total.saved += res.saved;
      total.modelCalls += res.modelCalls;
      total.attempted += res.attempted;
      total.deferred = res.deferred;
      if (res.stopped) total.stopped = res.stopped;
      if (res.saved > 0 && (n > 1 || res.attempted >= passCap || res.stopped)) {
        const { total: all, done } = repo.suggestions.progress(PROMPT_VERSION);
        log(
          `${done} of ${all} done after pass ${n} (${res.modelCalls} model calls, $${spentToday().toFixed(2)} today)` +
            (res.stopped ? `; stopped: ${res.stopped}` : ''),
        );
      }
      emitStatus(true);
      if (res.stopped || res.attempted === 0) break;
    }
    return total;
  }

  async function drain(): Promise<void> {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = (async () => {
      try {
        await drainLoop();
      } catch (e) {
        // Each pass guards itself; this is for what runs between passes. Nothing may escape a timer callback.
        log('background run failed', e);
      }
    })().finally(() => {
      running = null;
      emitStatus(true);
    });
    await running;
  }

  async function drainLoop(): Promise<void> {
    do {
      rerun = false;
      const all = backfillWanted;
      backfillWanted = false;
      const ids = [...pending];
      pending.clear();
      const res = all ? await runUntilDone() : ids.length > 0 ? await runUntilDone(ids) : null;
      // A pause dropped the work it interrupted: look at everything again when it ends.
      if (res?.stopped === 'backoff' || res?.stopped === 'cap') backfillWanted = true;
      // Items waiting on GitHub's budget: come back when it resets (a pause for those only).
      if (res && !res.stopped && deferred.size > 0) {
        const until = githubBlockedUntil();
        if (until > 0) {
          paused = { reason: 'rate-limit', until: new Date(until).toISOString() };
          backfillWanted = true;
          schedule(until - now().getTime() + 50);
          log(`${deferred.size} items wait for GitHub's rate limit to reset; resuming then`);
        }
      }
      emitStatus(true);
    } while (rerun && !stopped);
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
      // Filling in the profile is a reason to look at the whole inbox; until then a pass would only refuse again.
      if (!hasProfile()) {
        emitStatus(true);
        return;
      }
      backfillWanted = true;
      schedule(debounceMs);
    },
    notify(ids) {
      if (stopped || !getApiKey() || !hasProfile()) return;
      for (const id of ids) pending.add(id);
      schedule(debounceMs);
    },
    runOnce,
    async idle() {
      while (running) await running;
    },
    status,
  };
}
