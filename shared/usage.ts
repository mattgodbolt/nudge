/**
 * Internal usage counters: which features get used, and how. Counts only, kept in the local database (usage_daily).
 *
 * The allow-list below is the privacy mechanism. Every key is a fixed string defined here, so nothing typed or read
 * by the user (comment text, search strings, author names, item ids, URLs) can ever become part of one:
 * the server drops anything not in the list and the client never builds a key from content. Keep it that way when
 * adding keys: a key names a feature, never a thing the feature was applied to.
 */

/** How an action was invoked: keyboard shortcut, toolbar/button click, touch (phone tile, tap, long-press), palette. */
export type UsageVia = 'kbd' | 'btn' | 'touch' | 'palette';

const ALL_VIA: readonly UsageVia[] = ['kbd', 'btn', 'touch', 'palette'];

/** Actions the owner invokes, and the ways each can be invoked. Keys are `<action>.<via>`. */
export const USAGE_ACTIONS = {
  done: ALL_VIA,
  dismissed: ALL_VIA, // "no action needed": done, recorded as a dismissal
  replied: ALL_VIA,
  inbox: ALL_VIA, // move back to the inbox / unsnooze
  snooze: ALL_VIA, // opening the snooze menu
  mute: ALL_VIA,
  undo: ALL_VIA,
  reply: ALL_VIA, // opening the composer
  open_source: ALL_VIA, // open the comment, video, issue or repository on its own site
  select_toggle: ['kbd', 'btn', 'touch'],
  select_all: ALL_VIA,
  sync: ALL_VIA, // sync now, refresh, pull to refresh
  thread_open: ['kbd', 'btn', 'touch'],
  search_focus: ['kbd', 'palette'],
  assistant_open: ALL_VIA,
  nav: ['kbd'], // j/k and arrows through the list
} as const satisfies Record<string, readonly UsageVia[]>;

export type UsageAction = keyof typeof USAGE_ACTIONS;

/** Everything else the browser reports: one fixed key per feature. */
const CLIENT_PLAIN_KEYS = [
  // Views and panes opened
  'view.inbox',
  'view.done',
  'view.all',
  'view.snoozed',
  'view.sources',
  'view.source',
  'view.stats',
  'view.settings',
  'view.thread',
  'view.github_thread',
  'view.todo_thread',
  // Finer detail on how a feature was used
  'filter.applied', // a source, video, repository, kind or audience filter was applied
  'search.run', // a search ran (never what was searched for)
  'snooze.preset',
  'snooze.custom',
  'snooze.until_activity', // an "until activity" snooze was chosen
  'snooze.bucket', // a reason bucket was chosen with it
  'nudge.copy', // the drafted nudge was copied
  'bulk.apply', // an action applied to more than one item at once
  'assistant.voice', // dictation started in "Tell Nudge"
  'push.open', // a push notification was tapped
  // Sessions and devices
  'session.start',
  'session.active_minute',
  'app.pwa',
  'app.browser_tab',
  'device.phone',
  'device.desktop',
] as const;

/** Keys only the server writes (it knows the truth; a browser must not be able to inflate them). */
export const SERVER_USAGE_KEYS = [
  'assistant.call',
  'assistant.tool_call',
  'assistant.fail',
  'assistant.cost_micros', // micro-dollars
  'snooze_ai.call', // the small model calls around snoozing (bucketing a reason, drafting a nudge)
  'snooze_ai.fail',
  'snooze_ai.cost_micros', // micro-dollars; counts toward the same daily cost cap as suggestions
] as const;

export type ServerUsageKey = (typeof SERVER_USAGE_KEYS)[number];

const actionKeys = (Object.keys(USAGE_ACTIONS) as UsageAction[]).flatMap((a) =>
  USAGE_ACTIONS[a].map((v) => `${a}.${v}`),
);

/** Keys a browser may report. */
export const CLIENT_USAGE_KEYS: readonly string[] = [...actionKeys, ...CLIENT_PLAIN_KEYS];
/** Every key that can exist in usage_daily. */
export const USAGE_KEYS: readonly string[] = [...CLIENT_USAGE_KEYS, ...SERVER_USAGE_KEYS];

const clientKeySet: ReadonlySet<string> = new Set(CLIENT_USAGE_KEYS);
const allKeySet: ReadonlySet<string> = new Set(USAGE_KEYS);

export const isClientUsageKey = (k: string): boolean => clientKeySet.has(k);
export const isUsageKey = (k: string): boolean => allKeySet.has(k);

/** The key for an action invoked a given way, or null when that combination is not in the allow-list. */
export function actionKey(action: string, via: UsageVia): string | null {
  const k = `${action}.${via}`;
  return clientKeySet.has(k) ? k : null;
}

/**
 * Actions that were removed from the app. Their keys left the allow-list (so nothing can write them any more), but
 * counts already stored under them still come back in a report; this keeps them reading as one feature ("Label")
 * instead of a scatter of raw keys. Only label (user-defined labels, removed) is retired so far.
 */
const RETIRED_ACTIONS: ReadonlySet<string> = new Set(['label']);

/** The feature a key belongs to: `done.kbd` and `done.btn` are both "done"; plain keys are their own feature. */
export function featureOf(key: string): string {
  const dot = key.lastIndexOf('.');
  if (dot < 0) return key;
  const head = key.slice(0, dot);
  return head in USAGE_ACTIONS || RETIRED_ACTIONS.has(head) ? head : key;
}

/** All features, for the "never used" list. */
export const USAGE_FEATURES: readonly string[] = [...new Set(USAGE_KEYS.map(featureOf))];

/** How an action key was invoked, or null for keys that are not action keys. */
export function viaOf(key: string): UsageVia | null {
  const via = key.slice(key.lastIndexOf('.') + 1) as UsageVia;
  return featureOf(key) !== key && ALL_VIA.includes(via) ? via : null;
}

/** Largest increment accepted for one key in one request: a day of heavy use is well under it. */
export const MAX_COUNT_PER_KEY = 5000;
/** Most keys one request may carry. */
export const MAX_KEYS_PER_REQUEST = 100;

export interface SanitizedCounts {
  accepted: Record<string, number>;
  /** Keys that were dropped (unknown, not client-writable, or a bad count), clipped for display. */
  rejected: string[];
}

/**
 * Split a client-supplied counts object into what may be stored and what must not. Never throws on content: a
 * non-object yields nothing accepted. Rejected names are returned only so the caller can see what was dropped.
 */
export function sanitizeCounts(raw: unknown): SanitizedCounts {
  const accepted: Record<string, number> = {};
  const rejected: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { accepted, rejected };
  for (const [k, v] of Object.entries(raw)) {
    if (clientKeySet.has(k) && typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_COUNT_PER_KEY) {
      accepted[k] = v;
    } else {
      rejected.push(k.length > 64 ? `${k.slice(0, 63)}…` : k);
    }
  }
  return { accepted, rejected };
}

/* ---------------- API shapes ---------------- */

export interface UsageRow {
  day: string;
  key: string;
  count: number;
}

/** Item-event counts for a day, computed at read time from item_events. */
export interface UsageEventRow {
  day: string;
  kind: string;
  source: string;
  count: number;
}

export interface UsageDTO {
  /** Window size in days, ending today (UTC). */
  days: number;
  from: string;
  to: string;
  rows: UsageRow[];
  /** What the event log says happened to items in the same window (not copied into usage_daily). */
  events: UsageEventRow[];
  /** Allow-listed features with no uses at all in the window. */
  unused: string[];
}

export interface UsagePostResult {
  accepted: number;
  rejected: string[];
}
