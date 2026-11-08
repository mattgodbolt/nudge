import type { CommentDTO, ServerEvent } from '../../shared/types.js';
import type { EventBus, PushPayload, PushSender, PushService, Repo } from '../contracts.js';

export interface NotifierDeps {
  repo: Repo;
  bus: EventBus;
  sender: PushSender;
  publicKey: string;
  /** Collect arrivals for this long before sending, so one sync run is one notification. */
  coalesceMs?: number;
  /**
   * Arrivals older than this are not news (a freshly added source backfills history, or a slow-polled video turns up an
   * old comment), so they never notify.
   */
  maxAgeMs?: number;
  /** After this many consecutive failed sends a subscription is dropped. */
  maxFailures?: number;
  now?: () => number;
}

const SNIPPET = 140;
const MAX_VIDEOS_LISTED = 3;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET - 1)}…` : flat;
}

interface Resolved {
  comment: CommentDTO;
  videoTitle: string;
}

/**
 * Turns inbox arrivals into Web Push notifications. Listens to the event bus, coalesces for a short window, and
 * writes one notification per kind ("new comments", "snooze woke") per device that opted in.
 */
export function createPushNotifier(deps: NotifierDeps): PushService {
  const coalesceMs = deps.coalesceMs ?? 20_000;
  const maxAgeMs = deps.maxAgeMs ?? 48 * 3_600_000;
  const maxFailures = deps.maxFailures ?? 5;
  const now = deps.now ?? Date.now;
  const pending = { added: new Set<string>(), woke: new Set<string>() };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  function resolve(id: string, requireFresh: boolean): Resolved | null {
    const c = deps.repo.getComment(id);
    // Still needs attention? It may have been triaged, snoozed or deleted since the event.
    if (!c || c.state !== 'inbox' || c.isOwn) return null;
    if (requireFresh && now() - Date.parse(c.publishedAt) > maxAgeMs) return null;
    const title = deps.repo.getThread(c.threadId)?.video.title?.trim() || 'a video';
    return { comment: c, videoTitle: title };
  }

  /** One comment reads as itself; several are summarised by video. */
  function describe(kind: 'new' | 'woke', items: Resolved[]): PushPayload | null {
    if (items.length === 0) return null;
    const woke = kind === 'woke';
    if (items.length === 1) {
      const { comment: c, videoTitle } = items[0]!;
      return {
        title: `${woke ? 'Snoozed: ' : ''}${c.authorName} on ${videoTitle}`,
        body: snippet(c.textPlain),
        url: `/inbox?c=${encodeURIComponent(c.id)}`,
        tag: `nudge-${kind}-${c.id}`,
      };
    }
    // Group by video id (titles can repeat or be missing); show the busiest videos first.
    const perVideo = new Map<string, { title: string; n: number }>();
    for (const i of items) {
      const v = perVideo.get(i.comment.videoId) ?? { title: i.videoTitle, n: 0 };
      v.n++;
      perVideo.set(i.comment.videoId, v);
    }
    const ranked = [...perVideo.values()].sort((a, b) => b.n - a.n);
    const shown = ranked.slice(0, MAX_VIDEOS_LISTED).map((v) => `${v.title} (${v.n})`);
    const more = ranked.length - shown.length;
    return {
      title: woke ? `${items.length} snoozed comments are back` : `${items.length} new comments`,
      body: shown.join(', ') + (more > 0 ? ` and ${more} more` : ''),
      url: '/inbox',
      // A constant tag: the newest summary replaces the previous one instead of stacking up.
      tag: `nudge-${kind}-batch`,
    };
  }

  async function deliver(kind: 'new' | 'woke', payload: PushPayload): Promise<void> {
    const subs = deps.repo.listPushSubscriptions().filter((s) => (kind === 'new' ? s.newComments : s.snoozeWake));
    await Promise.all(
      subs.map(async (s) => {
        const result = await deps.sender.send(s, payload);
        if (result === 'gone') {
          deps.repo.deletePushSubscription(s.endpoint);
        } else {
          deps.repo.markPushResult(s.endpoint, result === 'ok');
          if (result === 'error' && s.failureCount + 1 >= maxFailures) deps.repo.deletePushSubscription(s.endpoint);
        }
      }),
    );
  }

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const added = [...pending.added];
    const woke = [...pending.woke];
    pending.added.clear();
    pending.woke.clear();
    if (deps.repo.listPushSubscriptions().length === 0) return;
    const fresh = added.flatMap((id) => resolve(id, true) ?? []);
    const wokeItems = woke.flatMap((id) => resolve(id, false) ?? []);
    for (const [kind, items] of [
      ['new', fresh],
      ['woke', wokeItems],
    ] as const) {
      const payload = describe(kind, items);
      if (payload) await deliver(kind, payload);
    }
  }

  const unsubscribe = deps.bus.subscribe((e: ServerEvent) => {
    if (e.type !== 'inbox.changed' || !e.reason || e.addedIds.length === 0) return;
    // Nobody to tell: do no work on every sync tick.
    if (deps.repo.listPushSubscriptions().length === 0) return;
    for (const id of e.addedIds) (e.reason === 'woke' ? pending.woke : pending.added).add(id);
    // Wake-ups go out promptly (the user asked for that time); sync arrivals wait for the rest of the batch.
    const delay = e.reason === 'woke' ? 0 : coalesceMs;
    if (timer && delay > 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      inFlight = inFlight.then(flush).catch((err) => console.warn('Push flush failed:', err));
    }, delay);
    timer.unref?.();
  });

  return {
    publicKey: () => deps.publicKey,
    async test(endpoint) {
      const sub = deps.repo.getPushSubscription(endpoint);
      if (!sub) return 'unknown';
      const result = await deps.sender.send(sub, {
        title: 'Nudge notifications are on',
        body: 'You will see new comments and snoozed ones coming back here.',
        url: '/inbox',
        tag: 'nudge-test',
      });
      if (result === 'gone') deps.repo.deletePushSubscription(endpoint);
      else deps.repo.markPushResult(endpoint, result === 'ok');
      return result;
    },
    stop() {
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = null;
    },
    flush: () => (inFlight = inFlight.then(flush)),
  };
}
