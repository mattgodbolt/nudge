import type { ItemEventInput, ItemEventPost } from '../../../shared/api';
import type { UsageVia } from '../../../shared/usage';
import { api } from './api';

/**
 * Private habit context: what was decided about an item, what was on screen at the time, and which items were opened
 * and for how long. It goes to the local server in batches (POST /api/item-events) and stays in the owner's own
 * database, so a later classifier can learn their triage habits. Item ids and list positions only, never text.
 *
 * Like usage.ts, nothing here may block, throw into or slow the UI: every entry point swallows its own errors, sending
 * is fire-and-forget and a failed batch is dropped. It does nothing until `start`, which refuses in demo mode and
 * under automation so those never write to a real table.
 */

const FLUSH_MS = 15_000;
/** Kept small: a keepalive request may not exceed 64 KB, and each event carries up to ten ids. */
const CHUNK = 50;
const MAX_QUEUE = 500;
const ABOVE_MAX = 10;
const MIN_DWELL_MS = 300;
const MAX_DWELL_MS = 3_600_000;
/** An input noted this long ago no longer explains an action (a menu left open, then something else happened). */
const INPUT_FRESH_MS = 30_000;

const INPUT_OF_VIA: Record<UsageVia, ItemEventInput> = {
  kbd: 'key',
  btn: 'button',
  touch: 'touch',
  palette: 'palette',
};

export interface DecisionContext {
  /** The action as the API call carried it: done, replied, inbox, snooze, unsnooze, label. */
  action: string;
  view: string;
  /** Every item of the list on screen, top to bottom, as it was before the action. `passable` false = not pending. */
  list: readonly { id: string; passable: boolean }[];
  /** The items the action applies to. */
  targets: readonly string[];
}

/** One `decision` event per target, with its position in the list and the items above it that were passed over. */
export function buildDecisions(ctx: DecisionContext, input: ItemEventInput, at: string): ItemEventPost[] {
  const acted = new Set(ctx.targets);
  const bulk = ctx.targets.length > 1;
  const index = new Map(ctx.list.map((x, i) => [x.id, i]));
  return ctx.targets.map((id) => {
    const rank = index.get(id) ?? null;
    const above: string[] = [];
    if (rank !== null) {
      for (let i = rank - 1; i >= 0 && above.length < ABOVE_MAX; i--) {
        const x = ctx.list[i]!;
        // Items acted on in the same bulk action were not passed over; neither were ones already dealt with.
        if (x.passable && !acted.has(x.id)) above.push(x.id);
      }
    }
    return {
      kind: 'decision',
      itemId: id,
      at,
      to: ctx.action,
      meta: {
        view: ctx.view,
        rank,
        listSize: ctx.list.length,
        above,
        input,
        bulk,
        selectionSize: ctx.targets.length,
      },
    };
  });
}

export interface DecisionsDeps {
  send: (events: ItemEventPost[]) => Promise<unknown>;
  now: () => number;
  doc?: Document;
  win?: Window;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

interface OpenRecord {
  itemId: string;
  view: string;
  input: ItemEventInput;
  openedAt: number;
  /** Visible time banked so far; `since` is when the current visible stretch began, null while hidden. */
  visibleMs: number;
  since: number | null;
}

export class Decisions {
  #enabled = false;
  #queue: ItemEventPost[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #open = new Set<OpenRecord>();
  #input: { input: ItemEventInput; at: number } | null = null;
  #stop: (() => void) | undefined;

  constructor(private deps: DecisionsDeps) {}

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Events waiting to be sent (for tests). */
  get pending(): readonly ItemEventPost[] {
    return this.#queue;
  }

  start(opts: { demo: boolean; automated?: boolean }): void {
    try {
      if (this.#enabled || opts.demo || opts.automated) return;
      this.#enabled = true;
      this.#attach();
    } catch {
      /* habit capture never breaks the app */
    }
  }

  stop(): void {
    this.#enabled = false;
    this.#stop?.();
    this.#stop = undefined;
    this.#queue = [];
    this.#open.clear();
    this.deps.clearTimer?.(this.#timer);
    this.#timer = undefined;
  }

  /** Remember how the latest command arrived; called where usage.binding is, which knows key vs button vs palette. */
  noteInput(via: UsageVia): void {
    this.#input = { input: INPUT_OF_VIA[via], at: this.deps.now() };
  }

  /** How the action happening now was invoked, or 'other' when nothing recent says. */
  input(): ItemEventInput {
    const n = this.#input;
    return n && this.deps.now() - n.at <= INPUT_FRESH_MS ? n.input : 'other';
  }

  /** Record the decisions for an action. Call before the list changes, so rank and `above` describe what was seen. */
  decide(ctx: DecisionContext): void {
    try {
      if (!this.#enabled || ctx.targets.length === 0) return;
      const at = new Date(this.deps.now()).toISOString();
      this.#enqueue(buildDecisions(ctx, this.input(), at));
    } catch {
      /* habit capture never breaks the app */
    }
  }

  /** An item's detail was opened from `view`. Returns the function to call when it closes (idempotent). */
  open(itemId: string, view: string): () => void {
    try {
      if (!this.#enabled) return () => {};
      const t = this.deps.now();
      const hidden = this.deps.doc?.visibilityState === 'hidden';
      const rec: OpenRecord = {
        itemId,
        view,
        input: this.input(),
        openedAt: t,
        visibleMs: 0,
        since: hidden ? null : t,
      };
      this.#open.add(rec);
      return () => this.#close(rec);
    } catch {
      return () => {};
    }
  }

  #close(rec: OpenRecord): void {
    try {
      if (!this.#open.delete(rec)) return;
      const t = this.deps.now();
      const dwell = rec.visibleMs + (rec.since === null ? 0 : t - rec.since);
      const meta: NonNullable<ItemEventPost['meta']> = { input: rec.input };
      if (dwell >= MIN_DWELL_MS) meta.dwellMs = Math.min(Math.round(dwell), MAX_DWELL_MS);
      this.#enqueue([
        { kind: 'open', itemId: rec.itemId, at: new Date(rec.openedAt).toISOString(), to: rec.view, meta },
      ]);
    } catch {
      /* habit capture never breaks the app */
    }
  }

  flush(): void {
    try {
      this.deps.clearTimer?.(this.#timer);
      this.#timer = undefined;
      if (!this.#enabled) return;
      const batch = this.#queue;
      this.#queue = [];
      for (let i = 0; i < batch.length; i += CHUNK) {
        const chunk = batch.slice(i, i + CHUNK);
        // Failures are dropped: this is context, not a record the app depends on.
        try {
          Promise.resolve(this.deps.send(chunk)).catch(() => {});
        } catch {
          /* dropped */
        }
      }
    } catch {
      /* habit capture never breaks the app */
    }
  }

  #enqueue(events: ItemEventPost[]): void {
    this.#queue.push(...events);
    if (this.#queue.length > MAX_QUEUE) this.#queue.splice(0, this.#queue.length - MAX_QUEUE);
    if (this.#timer === undefined && this.deps.setTimer) {
      this.#timer = this.deps.setTimer(() => {
        this.#timer = undefined;
        this.flush();
      }, FLUSH_MS);
    }
  }

  #attach(): void {
    const { doc, win } = this.deps;
    if (!doc || !win) return;
    const onVisibility = () => {
      const t = this.deps.now();
      for (const r of this.#open) {
        if (doc.visibilityState === 'hidden' && r.since !== null) {
          r.visibleMs += t - r.since;
          r.since = null;
        } else if (doc.visibilityState === 'visible' && r.since === null) r.since = t;
      }
      if (doc.visibilityState === 'hidden') this.flush();
    };
    const onPageHide = () => {
      for (const r of [...this.#open]) this.#close(r);
      this.flush();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pagehide', onPageHide);
    this.#stop = () => {
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pagehide', onPageHide);
    };
  }
}

const browser = typeof window !== 'undefined' && typeof document !== 'undefined';

/** The app-wide instance. Inert until `decisions.start` runs from boot. */
export const decisions = new Decisions({
  send: (events) => api.postItemEvents(events),
  now: () => Date.now(),
  ...(browser
    ? {
        doc: document,
        win: window,
        setTimer: setTimeout.bind(globalThis) as typeof setTimeout,
        clearTimer: clearTimeout.bind(globalThis) as typeof clearTimeout,
      }
    : {}),
});
