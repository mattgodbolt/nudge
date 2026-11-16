import {
  YtError,
  type EventBus,
  type QuotaTracker,
  type Repo,
  type SourceRow,
  type SyncEngine,
  type SyncRunReq,
  type VideoSyncRow,
  type YouTubeClient,
  type YtThread,
} from '../contracts.js';
import type { SyncRunSummary, SyncStatus } from '../../shared/types.js';
import { addMinutes, colder, tierFor } from './tiers.js';
import { attachVideos, fetchAllPlaylistItems, refreshVideoMetadata } from './membership.js';

export interface EngineDeps {
  repo: Repo;
  yt: YouTubeClient;
  quota: QuotaTracker;
  bus: EventBus;
  clock?: () => Date;
  /**
   * The YouTube key in use, wherever it came from (environment, Settings or key file). A rejected key stops background
   * polls until this changes. Default: the key in Settings.
   */
  currentKey?: () => string | null;
}

export const POLL_BATCH = 25;
export const FEED_INTERVAL_MIN = 10;
export const MEMBERSHIP_INTERVAL_MIN = 60;
export const META_INTERVAL_MIN = 24 * 60;
export const COMMENTS_DISABLED_RECHECK_MIN = 7 * 24 * 60;
export const MAX_PAGES = 50;
/** Deep scans are capped so one huge video can't eat the budget; the own-channel feed covers the rest. */
export const MAX_DEEP_PAGES = 20;
const INBOX_DEBOUNCE_MS = 250;
const MAX_BACKOFF_MIN = 24 * 60;
/** A thread whose fetched replies can't reach its total (deleted/held replies) is re-fetched at most this often. */
export const REPLY_REFETCH_MIN = 6 * 60;
/** Failing memberships/feeds are skipped by background polls for 2^n minutes, capped at this. */
export const MAX_SOURCE_BACKOFF_MIN = 6 * 60;

/** Aborts the whole run (quota exhausted, bad key, network down). */
class AbortRun extends Error {}

/** The quota check said stop mid-scan; the scan's incomplete marker stays set so it resumes later. */
class ScanStopped extends Error {}

interface Job {
  req: SyncRunReq;
  waiters: { resolve: (s: SyncRunSummary) => void }[];
}

interface Acc {
  added: Set<string>;
  changed: Set<string>;
}

export function createSyncEngine(deps: EngineDeps): SyncEngine {
  const { repo, yt, quota, bus } = deps;
  const clock = deps.clock ?? (() => new Date());

  const queue: Job[] = [];
  let draining = false;
  const st: SyncStatus = {
    running: false,
    runId: null,
    trigger: null,
    done: 0,
    total: 0,
    currentVideoId: null,
    lastRun: null,
  };
  const feedLastAt = new Map<number, number>();
  /** Consecutive failures per membership/feed job ("m:<id>" / "f:<id>"), for background-poll backoff. */
  const failures = new Map<string, { n: number; until: number }>();
  /** Set when YouTube rejected the key; background polling resumes once the stored key changes or a manual sync runs. */
  let keyBlock: { apiKey: string | null } | null = null;
  const currentKey = deps.currentKey ?? (() => repo.getSettings().apiKey);
  /** Installed per run: false once the quota says stop. Checked between pages so one video can't blow the budget. */
  let shouldContinue: () => boolean = () => true;
  const checkpoint = (): void => {
    if (!shouldContinue()) throw new ScanStopped();
  };
  const backedOff = (key: string, nowMs: number): boolean => (failures.get(key)?.until ?? 0) > nowMs;
  const noteFailure = (key: string, nowMs: number): void => {
    const n = (failures.get(key)?.n ?? 0) + 1;
    failures.set(key, { n, until: nowMs + Math.min(2 ** n, MAX_SOURCE_BACKOFF_MIN) * 60_000 });
  };

  const metaLastAt = new Map<number, number>();
  const acc: Acc = { added: new Set(), changed: new Set() };
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let runNewComments = 0;

  const status = (): SyncStatus => ({ ...st, lastRun: repo.lastRun() });
  const progress = () => bus.emit({ type: 'sync.progress', status: status() });

  /* ---------- inbox.changed debouncing ---------- */
  function flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!acc.added.size && !acc.changed.size) return;
    const addedIds = [...acc.added].filter((id) => repo.getComment(id)?.state === 'inbox');
    const changedIds = [...acc.changed].filter((id) => !acc.added.has(id));
    acc.added.clear();
    acc.changed.clear();
    runNewComments += addedIds.length;
    if (!addedIds.length && !changedIds.length) return;
    bus.emit({ type: 'inbox.changed', counts: repo.counts(), addedIds, changedIds, reason: 'sync' });
  }
  function collect(r: { newCommentIds: string[]; changedIds: string[]; wokenIds?: string[] }): void {
    // A snoozed thread that got a reply comes back now, not after the debounce: it is the thing he was waiting for.
    if (r.wokenIds?.length) {
      bus.emit({ type: 'inbox.changed', counts: repo.counts(), addedIds: r.wokenIds, changedIds: [], reason: 'woke' });
    }
    for (const id of r.newCommentIds) acc.added.add(id);
    for (const id of r.changedIds) acc.changed.add(id);
    if (!flushTimer) {
      flushTimer = setTimeout(flush, INBOX_DEBOUNCE_MS);
      flushTimer.unref?.();
    }
  }

  /* ---------- threads ---------- */
  async function handleThread(t: YtThread, deep: boolean): Promise<{ known: boolean; changed: boolean }> {
    const prev = repo.getThreadState(t.id);
    collect(repo.upsertThread(t));
    // upsertThread has already stored the new reply total, so judge "missing replies" by what we actually hold.
    // A failed fetch leaves fetched < total and no last_reply_fetch_at, so the next poll retries; threads whose
    // replies can never be fetched (deleted/held) are only retried once per REPLY_REFETCH_MIN (or on deep scans).
    const cur = repo.getThreadState(t.id);
    const lastFetch = cur?.lastReplyFetchAt ? new Date(cur.lastReplyFetchAt).getTime() : null;
    const retryDue = lastFetch === null || clock().getTime() - lastFetch >= REPLY_REFETCH_MIN * 60_000;
    const needReplies = !!cur && cur.fetchedReplyCount < t.totalReplyCount && (deep || retryDue);
    if (needReplies) {
      let pageToken: string | undefined;
      do {
        checkpoint();
        const page = await yt.listReplies({ parentId: t.id, pageToken });
        if (page.items.length) collect(repo.addReplies(t.id, page.items));
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken);
      repo.markRepliesFetched(t.id);
    }
    return { known: !!prev, changed: !!prev && prev.totalReplyCount !== t.totalReplyCount };
  }

  async function syncVideoComments(row: VideoSyncRow, deep: boolean): Promise<void> {
    const cap = deep ? MAX_DEEP_PAGES : MAX_PAGES;
    // An interrupted or first-time scan hasn't reached the older pages: don't stop at the first all-known page.
    const resume = !deep && (row.scanIncomplete || row.lastSyncedAt === null);
    let pageToken: string | undefined;
    for (let pages = 0; pages < cap; pages++) {
      checkpoint();
      const page = await yt.listCommentThreads({ videoId: row.id, pageToken });
      let interesting = false;
      for (const t of page.items.filter((x) => x.videoId)) {
        const r = await handleThread(t, deep);
        if (!r.known || r.changed) interesting = true;
      }
      if (!deep) {
        if (!interesting && !resume) return;
        const last = page.items.at(-1);
        if (row.baselineAt && last && last.topComment.publishedAt < row.baselineAt) return;
      }
      if (!page.nextPageToken) return;
      pageToken = page.nextPageToken;
    }
  }

  async function syncVideo(
    videoId: string,
    o: { deep: boolean; ignoreBackoff: boolean },
  ): Promise<'synced' | 'skipped' | 'failed'> {
    let row = repo.getVideoSyncRow(videoId);
    const now = clock();
    if (!row || row.missing) return 'skipped';
    if (row.backoffUntil && new Date(row.backoffUntil) > now && !o.ignoreBackoff) return 'skipped';
    if (row.commentsDisabled && !o.deep && row.nextSyncAt && new Date(row.nextSyncAt) > now) return 'skipped';

    if (!row.metaRefreshedAt) {
      // Still a stub (an earlier getVideos failed): get the publish date before choosing a tier.
      try {
        checkpoint();
        const vs = await yt.getVideos([videoId]);
        repo.upsertVideos(vs);
        if (!vs.length) {
          repo.updateVideoSync(videoId, { missing: true, lastError: 'Video not found (private or deleted)' });
          return 'skipped';
        }
        row = repo.getVideoSyncRow(videoId) ?? row;
      } catch (e) {
        if (e instanceof ScanStopped) throw e;
        if (!(e instanceof YtError)) throw e;
        if (e.reason === 'quotaExceeded' || e.reason === 'keyInvalid' || e.reason === 'network') throw e;
        // Other API errors: carry on with the stub; the next membership refresh retries the metadata.
      }
    }

    let info = tierFor(row.publishedAt, row.pollTier, now);
    if (row.isOwnChannel) info = colder(info);
    const deep =
      o.deep ||
      (row.lastSyncedAt !== null &&
        Number.isFinite(info.deepEveryMin) &&
        (!row.lastDeepScanAt || now.getTime() - new Date(row.lastDeepScanAt).getTime() >= info.deepEveryMin * 60_000));

    // Persist "scan in progress" first; it is cleared only when the scan ends normally.
    if (!row.scanIncomplete) repo.updateVideoSync(videoId, { scanIncomplete: true });
    try {
      await syncVideoComments(row, deep);
    } catch (e) {
      if (!(e instanceof YtError)) throw e;
      switch (e.reason) {
        case 'quotaExceeded':
        case 'keyInvalid':
        case 'network':
          throw e;
        case 'commentsDisabled':
          repo.updateVideoSync(videoId, {
            commentsDisabled: true,
            lastSyncedAt: now.toISOString(),
            nextSyncAt: addMinutes(now, COMMENTS_DISABLED_RECHECK_MIN).toISOString(),
            scanIncomplete: false,
            lastError: null,
            errorCount: 0,
            backoffUntil: null,
          });
          return 'synced';
        case 'notFound':
          repo.updateVideoSync(videoId, { missing: true, lastError: e.message, nextSyncAt: null });
          return 'failed';
        default: {
          const n = row.errorCount + 1;
          const until = addMinutes(now, Math.min(2 ** n * 5, MAX_BACKOFF_MIN)).toISOString();
          repo.updateVideoSync(videoId, {
            errorCount: n,
            backoffUntil: until,
            nextSyncAt: until,
            lastError: e.message,
          });
          bus.emit({ type: 'error', message: `${videoId}: ${e.message}`, videoId });
          return 'failed';
        }
      }
    }

    repo.updateVideoSync(videoId, {
      commentsDisabled: false,
      lastSyncedAt: now.toISOString(),
      scanIncomplete: false,
      lastDeepScanAt: deep || row.lastSyncedAt === null ? now.toISOString() : row.lastDeepScanAt,
      nextSyncAt: Number.isFinite(info.intervalMin) ? addMinutes(now, info.intervalMin).toISOString() : null,
      errorCount: 0,
      backoffUntil: null,
      lastError: null,
    });
    return 'synced';
  }

  /* ---------- own channel feed ---------- */
  async function syncFeed(src: SourceRow, deep: boolean): Promise<void> {
    const cap = deep ? MAX_DEEP_PAGES : MAX_PAGES;
    // Same resume rule as videos: an interrupted feed scan must not stop at the first all-known page.
    const resume = !deep && (repo.getSourceRow(src.id)?.feedScanIncomplete ?? false);
    repo.updateSource(src.id, { feedScanIncomplete: true });
    let pageToken: string | undefined;
    for (let pages = 0; pages < cap; pages++) {
      checkpoint();
      const page = await yt.listCommentThreads({ allThreadsRelatedToChannelId: src.ytId, pageToken });
      // Some feed threads come back without a video id; there is nothing to attach them to.
      const items = page.items.filter((t) => t.videoId);
      const unknown = [...new Set(items.map((t) => t.videoId))].filter((id) => !repo.getVideoSyncRow(id));
      if (unknown.length) {
        // Keep existing membership and append the new videos so they inherit this source's baseline rules.
        const existing = repo.allVideoRows(src.id).map((v, i) => ({ videoId: v.id, position: i }));
        await attachVideos(repo, yt, src.id, [
          ...existing,
          ...unknown.map((id, i) => ({ videoId: id, position: existing.length + i })),
        ]);
      }
      let interesting = false;
      let allBeforeBaseline = items.length > 0;
      for (const t of items) {
        const baseline = repo.getVideoSyncRow(t.videoId)?.baselineAt;
        const r = await handleThread(t, deep);
        const beforeBaseline = !!baseline && t.topComment.publishedAt < baseline;
        if (!beforeBaseline) allBeforeBaseline = false;
        if ((!r.known || r.changed) && !beforeBaseline) interesting = true;
      }
      if (!deep && !interesting && (!resume || allBeforeBaseline)) break;
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    repo.updateSource(src.id, { feedScanIncomplete: false });
  }

  async function refreshMembership(src: SourceRow, nowMs: number): Promise<void> {
    if (src.kind === 'video') return;
    const playlistId = src.kind === 'channel' ? src.uploadsPlaylistId : src.ytId;
    if (!playlistId) return;
    const items = await fetchAllPlaylistItems(yt, playlistId);
    const { added } = await attachVideos(repo, yt, src.id, items);
    const metaDue = nowMs - (metaLastAt.get(src.id) ?? 0) >= META_INTERVAL_MIN * 60_000;
    if (metaDue) {
      // New videos just got fresh metadata; otherwise refresh the whole source once a day.
      if (!added.length) await refreshVideoMetadata(repo, yt, src.id);
      metaLastAt.set(src.id, nowMs);
    }
    repo.updateSource(src.id, { membershipRefreshedAt: clock().toISOString(), lastError: null });
    if (added.length) bus.emit({ type: 'sources.changed', sources: repo.listSources() });
  }

  /* ---------- planning ---------- */
  const membershipStale = (s: SourceRow, nowMs: number) =>
    s.kind !== 'video' &&
    (!s.membershipRefreshedAt ||
      nowMs - new Date(s.membershipRefreshedAt).getTime() >= MEMBERSHIP_INTERVAL_MIN * 60_000);
  const isFeed = (s: SourceRow) => s.kind === 'channel' && s.isOwn;

  function manualVideoOrder(sources: SourceRow[], now: Date): string[] {
    const rows = new Map<string, VideoSyncRow>();
    for (const s of sources) for (const v of repo.allVideoRows(s.id)) rows.set(v.id, v);
    const rank = (v: VideoSyncRow) => (tierFor(v.publishedAt, v.pollTier, now).tier === 'hot' ? 0 : 1);
    return [...rows.values()]
      .filter((v) => v.pollTier !== 'paused')
      .sort((a, b) => rank(a) - rank(b) || (a.lastSyncedAt ?? '').localeCompare(b.lastSyncedAt ?? ''))
      .map((v) => v.id);
  }

  function idleSummary(req: SyncRunReq): SyncRunSummary {
    const t = clock().toISOString();
    return {
      id: 0,
      trigger: req.trigger,
      startedAt: t,
      finishedAt: t,
      units: 0,
      videos: 0,
      newComments: 0,
      error: null,
    };
  }

  async function execute(req: SyncRunReq): Promise<SyncRunSummary> {
    const now = clock();
    const nowMs = now.getTime();
    const manual = req.trigger !== 'poll';
    if (manual) {
      keyBlock = null;
    } else if (keyBlock && currentKey() === keyBlock.apiKey) {
      return idleSummary(req); // the key was rejected: don't spend units until it changes or the user syncs manually
    }
    const allSources = repo.enabledSourceRows();

    let memberships: SourceRow[] = [];
    let feeds: SourceRow[] = [];
    let videoPlan: () => string[];
    if (req.scope === 'video') {
      videoPlan = () => [String(req.id)];
    } else if (req.scope === 'source') {
      const src = repo.getSourceRow(Number(req.id));
      if (!src) return { ...idleSummary(req), error: `Source ${req.id} not found` };
      memberships = src.kind !== 'video' && (req.trigger === 'manual' || membershipStale(src, nowMs)) ? [src] : [];
      feeds = isFeed(src) ? [src] : [];
      videoPlan = () =>
        repo
          .allVideoRows(src.id)
          .filter((v) => manual || v.pollTier !== 'paused')
          .map((v) => v.id);
    } else if (manual) {
      memberships = allSources.filter((s) => membershipStale(s, nowMs));
      feeds = allSources.filter(isFeed);
      videoPlan = () => manualVideoOrder(repo.enabledSourceRows(), clock());
    } else {
      memberships = allSources.filter((s) => membershipStale(s, nowMs) && !backedOff(`m:${s.id}`, nowMs));
      feeds = allSources.filter(
        (s) =>
          isFeed(s) &&
          nowMs - (feedLastAt.get(s.id) ?? 0) >= FEED_INTERVAL_MIN * 60_000 &&
          !backedOff(`f:${s.id}`, nowMs),
      );
      videoPlan = () => repo.dueVideos(clock(), POLL_BATCH).map((v) => v.id);
    }
    if (!manual && !memberships.length && !feeds.length && !repo.dueVideos(now, 1).length) return idleSummary(req);

    const scopeLabel = req.scope === 'all' ? 'all' : `${req.scope}:${req.id}`;
    const runId = repo.startRun(req.trigger, scopeLabel);
    const unitsBefore = quota.used();
    Object.assign(st, {
      running: true,
      runId,
      trigger: req.trigger,
      done: 0,
      total: memberships.length + feeds.length,
      currentVideoId: null,
    });
    runNewComments = 0;
    let videosSynced = 0;
    let error: string | null = null;
    let networkFailures = 0;
    progress();

    const mayContinue = (): boolean => {
      if (manual ? quota.canManual() : quota.canPoll()) return true;
      if (manual || !quota.snapshot().blockedUntil) error ??= manual ? 'Daily quota budget reached' : null;
      return false;
    };
    shouldContinue = mayContinue;
    const step = async (fn: () => Promise<void>, onError?: (e: YtError) => void): Promise<boolean> => {
      if (!mayContinue()) return false;
      try {
        await fn();
        networkFailures = 0;
      } catch (e) {
        if (e instanceof ScanStopped) return false;
        if (!(e instanceof YtError)) throw e;
        if (e.reason === 'quotaExceeded') {
          quota.blockUntilNextDay();
          bus.emit({ type: 'quota.update', quota: quota.snapshot() });
          error = 'YouTube daily quota exceeded; sync blocked until Pacific midnight';
          return false;
        }
        if (e.reason === 'keyInvalid') {
          keyBlock = { apiKey: currentKey() };
          error = e.message;
          return false;
        }
        if (e.reason === 'network' && ++networkFailures >= 3) {
          error = e.message;
          return false;
        }
        onError?.(e);
        bus.emit({ type: 'error', message: e.message });
      }
      st.done++;
      progress();
      return true;
    };

    try {
      let ok = true;
      for (const src of memberships) {
        ok = await step(
          async () => {
            await refreshMembership(src, nowMs);
            failures.delete(`m:${src.id}`);
          },
          (e) => {
            noteFailure(`m:${src.id}`, nowMs);
            repo.updateSource(src.id, { lastError: e.message });
          },
        );
        if (!ok) break;
      }
      for (const src of ok ? feeds : []) {
        ok = await step(
          async () => {
            await syncFeed(src, !!req.deep);
            feedLastAt.set(src.id, nowMs);
            failures.delete(`f:${src.id}`);
          },
          (e) => {
            noteFailure(`f:${src.id}`, nowMs);
            repo.updateSource(src.id, { lastError: e.message });
          },
        );
        if (!ok) break;
      }
      if (ok) {
        const videos = videoPlan();
        st.total += videos.length;
        progress();
        for (const id of videos) {
          st.currentVideoId = id;
          const result = { v: 'skipped' as 'synced' | 'skipped' | 'failed' };
          ok = await step(async () => {
            result.v = await syncVideo(id, { deep: !!req.deep, ignoreBackoff: req.scope === 'video' });
          });
          if (result.v === 'synced') videosSynced++;
          flush(); // per-video flush keeps the UI lively and the order deterministic
          bus.emit({ type: 'quota.update', quota: quota.snapshot() });
          if (!ok) break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    shouldContinue = () => true;
    flush();
    const summary = repo.finishRun(runId, {
      units: Math.max(0, quota.used() - unitsBefore),
      videos: videosSynced,
      newComments: runNewComments,
      error,
    });
    Object.assign(st, { running: false, runId: null, trigger: null, currentVideoId: null });
    bus.emit({ type: 'sync.done', summary });
    bus.emit({ type: 'quota.update', quota: quota.snapshot() });
    progress();
    return summary;
  }

  /* ---------- queue: one run at a time, manual requests jump ahead of polls ---------- */
  async function drain(): Promise<void> {
    draining = true;
    try {
      while (queue.length) {
        const job = queue.shift() as Job;
        let summary: SyncRunSummary;
        try {
          summary = await execute(job.req);
        } catch (e) {
          summary = { ...idleSummary(job.req), error: e instanceof Error ? e.message : String(e) };
        }
        for (const w of job.waiters) w.resolve(summary);
      }
    } finally {
      draining = false;
    }
  }

  return {
    run(req) {
      return new Promise<SyncRunSummary>((resolve) => {
        const existing = queue.find((j) => j.req.scope === req.scope && j.req.id === req.id);
        if (existing) {
          existing.req.deep = existing.req.deep || req.deep;
          if (req.trigger !== 'poll' && existing.req.trigger === 'poll') {
            existing.req.trigger = req.trigger;
            queue.splice(queue.indexOf(existing), 1);
            queue.splice(firstPollIndex(), 0, existing);
          }
          existing.waiters.push({ resolve });
          return;
        }
        const job: Job = { req: { ...req }, waiters: [{ resolve }] };
        if (req.trigger === 'poll') queue.push(job);
        else queue.splice(firstPollIndex(), 0, job);
        if (!draining) void drain();
      });
    },
    status,
  };

  function firstPollIndex(): number {
    const i = queue.findIndex((j) => j.req.trigger === 'poll');
    return i < 0 ? queue.length : i;
  }
}
