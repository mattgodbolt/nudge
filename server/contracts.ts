// Server-internal interfaces shared by the db / sync / http chunks.
// Owned by the lead; implementers must conform to these and ask before changing them.
import type {
  CommentDTO,
  CommentState,
  Counts,
  ImportMode,
  InboxItem,
  PollTier,
  QuotaDTO,
  ServerEvent,
  SettingsDTO,
  SourceDTO,
  SourceKind,
  SyncRunSummary,
  SyncStatus,
  ThreadDetail,
  TriageResult,
  VideoDTO,
  ReplyResult,
  Capabilities,
} from '../shared/types.js';
import type { DraftDTO, InboxPage, InboxQuery, SyncRequest } from '../shared/api.js';

/* ---------------- YouTube API shapes (already normalised) ---------------- */
export interface Page<T> {
  items: T[];
  nextPageToken: string | null;
}
export interface YtComment {
  id: string;
  parentId: string | null;
  videoId: string;
  authorName: string;
  authorChannelId: string | null;
  authorAvatarUrl: string | null;
  textHtml: string;
  likeCount: number;
  publishedAt: string;
  updatedAt: string;
}
export interface YtThread {
  id: string;
  videoId: string;
  channelId: string | null;
  canReply: boolean;
  topComment: YtComment;
  totalReplyCount: number;
  /** Inline replies: YouTube returns only a subset (usually <= 5). */
  replies: YtComment[];
}
export interface YtVideo {
  id: string;
  title: string;
  channelId: string | null;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  commentCount: number | null;
}
export interface YtChannel {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string | null;
}
export interface YtPlaylist {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  channelId: string | null;
}

export type YtErrorReason =
  'quotaExceeded' | 'commentsDisabled' | 'notFound' | 'forbidden' | 'badRequest' | 'keyInvalid' | 'network' | 'unknown';
export class YtError extends Error {
  constructor(
    public reason: YtErrorReason,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'YtError';
  }
}

export interface YouTubeClient {
  listCommentThreads(p: {
    videoId?: string;
    allThreadsRelatedToChannelId?: string;
    pageToken?: string;
  }): Promise<Page<YtThread>>;
  listReplies(p: { parentId: string; pageToken?: string }): Promise<Page<YtComment>>;
  listPlaylistItems(p: {
    playlistId: string;
    pageToken?: string;
  }): Promise<Page<{ videoId: string; position: number }>>;
  getVideos(ids: string[]): Promise<YtVideo[]>;
  getChannel(p: { id?: string; handle?: string }): Promise<YtChannel | null>;
  getPlaylist(id: string): Promise<YtPlaylist | null>;
}

/* ---------------- Repo (SQLite) ---------------- */
export interface StoredSettings {
  apiKey: string | null;
  ownChannelIds: string[];
  pollEnabled: boolean;
  dailyQuotaBudget: number;
  manualReserve: number;
  backfillDays: number;
  theme: 'system' | 'light' | 'dark';
}
export interface NewSource {
  kind: SourceKind;
  ytId: string;
  title: string | null;
  thumbnailUrl: string | null;
  isOwn: boolean;
  importMode: ImportMode;
  uploadsPlaylistId?: string | null;
}
export interface SourceRow extends NewSource {
  id: number;
  enabled: boolean;
  membershipRefreshedAt: string | null;
  /** The own-channel feed scan started but has not completed normally. */
  feedScanIncomplete: boolean;
}
export interface VideoSyncRow {
  id: string;
  channelId: string | null;
  publishedAt: string | null;
  commentsDisabled: boolean;
  missing: boolean;
  baselineAt: string | null;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  lastDeepScanAt: string | null;
  errorCount: number;
  backoffUntil: string | null;
  lastError: string | null;
  pollTier: PollTier | null;
  isOwnChannel: boolean;
  /** Metadata (publish date etc.) has never been fetched: the row is only a stub. */
  metaRefreshedAt: string | null;
  /** A comment scan started but has not completed normally; the next scan must not stop early. */
  scanIncomplete: boolean;
}
export interface Repo {
  close(): void;
  getSettings(): StoredSettings;
  updateSettings(p: Partial<StoredSettings>): StoredSettings;

  listSources(): SourceDTO[];
  getSourceRow(id: number): SourceRow | null;
  enabledSourceRows(): SourceRow[];
  addSource(s: NewSource): SourceDTO;
  updateSource(
    id: number,
    p: Partial<{
      enabled: boolean;
      isOwn: boolean;
      title: string;
      importMode: ImportMode;
      membershipRefreshedAt: string;
      lastError: string | null;
      feedScanIncomplete: boolean;
    }>,
  ): SourceDTO;
  deleteSource(id: number, purge: boolean): void;
  /** Attach videos to a source (creating stub video rows with baseline_at from the source import mode). */
  setSourceVideos(sourceId: number, videos: { id: string; position: number }[]): { added: string[] };

  upsertVideos(v: YtVideo[]): void;
  listVideos(sourceId?: number): VideoDTO[];
  setVideoTier(id: string, t: PollTier | null): VideoDTO;
  dueVideos(now: Date, limit: number): VideoSyncRow[];
  allVideoRows(sourceId?: number): VideoSyncRow[];
  getVideoSyncRow(id: string): VideoSyncRow | null;
  updateVideoSync(id: string, p: Partial<VideoSyncRow>): void;

  getThreadState(
    threadId: string,
  ): { totalReplyCount: number; fetchedReplyCount: number; lastReplyFetchAt: string | null } | null;
  /** Record that every reply page of the thread was fetched successfully (now). */
  markRepliesFetched(threadId: string): void;
  /** Upserts thread + top comment + inline replies, applies state rules and auto-clear, in one transaction. */
  upsertThread(t: YtThread): { newCommentIds: string[]; changedIds: string[] };
  addReplies(threadId: string, replies: YtComment[]): { newCommentIds: string[]; changedIds: string[] };
  recomputeOwnership(ownIds: string[]): void;

  listInbox(q: InboxQuery): InboxPage;
  getThread(threadId: string): ThreadDetail | null;
  getComment(id: string): CommentDTO | null;
  triage(ids: string[], to: CommentState): TriageResult;
  undo(actionId: number): TriageResult;
  markHandedOff(commentId: string, body: string): TriageResult;
  getDraft(commentId: string): DraftDTO | null;
  putDraft(commentId: string, body: string): DraftDTO;
  deleteDraft(commentId: string): void;
  counts(): Counts;

  recordQuota(dayPt: string, endpoint: string, units: number): void;
  quotaUsed(dayPt: string): number;
  quotaByEndpoint(dayPt: string): { endpoint: string; units: number; calls: number }[];
  startRun(trigger: string, scope: string): number;
  finishRun(
    id: number,
    p: { units: number; videos: number; newComments: number; error: string | null },
  ): SyncRunSummary;
  lastRun(): SyncRunSummary | null;
}

/* ---------------- Events, sync, reply ---------------- */
export interface EventBus {
  emit(e: ServerEvent): void;
  subscribe(fn: (e: ServerEvent) => void): () => void;
}

export interface QuotaTracker {
  dayPt(): string;
  charge(endpoint: string, units: number): void;
  used(): number;
  snapshot(): QuotaDTO;
  /** True if background polling may spend more today. */
  canPoll(): boolean;
  /** True if a manual sync may spend more today. */
  canManual(): boolean;
  blockUntilNextDay(): void;
}

export interface SyncRunReq {
  trigger: 'manual' | 'poll' | 'source-added';
  scope: SyncRequest['scope'];
  id?: string | number;
  deep?: boolean;
}
export interface SyncEngine {
  run(req: SyncRunReq): Promise<SyncRunSummary>;
  status(): SyncStatus;
}
export interface Scheduler {
  start(): void;
  stop(): void;
}

export interface ReplyPoster {
  capabilities(): Capabilities;
  reply(comment: CommentDTO, body: string): Promise<ReplyResult>;
}

/** Everything the HTTP layer needs. */
export interface AppDeps {
  repo: Repo;
  engine: SyncEngine;
  bus: EventBus;
  quota: QuotaTracker;
  poster: ReplyPoster;
  /** Resolve + add a source (and kick off its first sync). */
  addSource(input: string, opts: { importMode?: ImportMode; isOwn?: boolean }): Promise<SourceDTO>;
  /** Check a YouTube API key with a 1-unit call. */
  testKey(apiKey: string): Promise<{ ok: boolean; message: string }>;
  /** Called after settings change (e.g. own channel ids) so the server can react. */
  onSettingsChanged(): void;
  resolveApiKey(): { key: string | null; source: 'env' | 'settings' | 'file' | null };
  demo: boolean;
  /** Demo mode only: force new comments to appear. */
  demoTick?: () => void;
  staticDir?: string;
}
export type { QuotaDTO, SettingsDTO, InboxItem };
