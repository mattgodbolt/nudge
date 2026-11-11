// Server-internal interfaces shared by the db / sync / http chunks.
// Owned by the lead; implementers must conform to these and ask before changing them.
import type {
  LabelApplyResult,
  LabelColor,
  LabelDTO,
  SnoozeResult,
  StatsDTO,
  GoogleAuthDTO,
  CommentDTO,
  CommentState,
  Counts,
  ImportMode,
  InboxItem,
  PollTier,
  QuotaDTO,
  ServerEvent,
  PushPrefs,
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
  FeedDTO,
  GithubAssociation,
  GithubDiscussionDTO,
  ItemDTO,
  MuteKind,
  MuteRuleDTO,
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
  /** Optional so older fixtures stay valid; null/absent = unknown. */
  durationSeconds?: number | null;
  likeCount?: number | null;
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
  /** Google OAuth client (from the Cloud console). The secret is never sent to the browser. */
  googleClient: { clientId: string; clientSecret: string } | null;
  ownChannelIds: string[];
  pollEnabled: boolean;
  dailyQuotaBudget: number;
  manualReserve: number;
  backfillDays: number;
  theme: 'system' | 'light' | 'dark';
  /** GitHub: a read-only token (never sent to the browser) and the logins that are me. */
  github: { token: string | null; myAccounts: string[] };
  llm: { apiKey: string | null; model: string };
}
export interface NewFeed {
  owner: string;
  prs: boolean;
  issues: boolean;
  importMode: ImportMode;
}
export interface FeedRow {
  id: number;
  provider: 'github';
  owner: string;
  ownerType: 'org' | 'user' | null;
  prs: boolean;
  issues: boolean;
  enabled: boolean;
  importMode: ImportMode;
  addedAt: string;
  baselineAt: string | null;
  cursor: string | null;
  lastPolledAt: string | null;
  nextPollAt: string | null;
  errorCount: number;
  backoffUntil: string | null;
  lastError: string | null;
  rate: { limit: number; remaining: number; resetAt: string } | null;
}
export interface FeedPollResult {
  cursor?: string | null;
  ownerType?: 'org' | 'user' | null;
  nextPollAt: string;
  errorCount: number;
  backoffUntil?: string | null;
  error?: string | null;
  rate?: { limit: number; remaining: number; resetAt: string } | null;
}
/** One pull request or issue as the poller hands it to the repo. */
export interface GithubItemUpsert {
  id: string;
  kind: 'pr' | 'issue';
  /** "owner/repo". */
  repo: string;
  number: number;
  title: string;
  author: string;
  authorAvatarUrl: string | null;
  authorType: string | null;
  association: GithubAssociation | null;
  bodyPlain: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  sourceState: 'open' | 'closed' | 'merged';
  draft: boolean;
  comments: number;
  labels: string[];
  /** Set by the poller when the comment count grew: was the newest comment mine? (undefined = unknown) */
  lastCommenterIsMe?: boolean;
  /** Set alongside lastCommenterIsMe: who wrote it, for the "New comment from @login" chip. */
  lastCommenter?: string;
}
export interface UpsertGithubResult {
  /** New arrivals that need attention. */
  added: string[];
  /** Done or resolved items that came back (new activity or reopened). */
  reopened: string[];
  changed: string[];
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
export interface PushSubscriptionRow extends PushPrefs {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
}
export interface Repo {
  close(): void;
  /* --- Web Push (migration 006) --- */
  listPushSubscriptions(): PushSubscriptionRow[];
  getPushSubscription(endpoint: string): PushSubscriptionRow | null;
  upsertPushSubscription(s: {
    endpoint: string;
    p256dh: string;
    auth: string;
    label: string | null;
    prefs: PushPrefs;
  }): void;
  deletePushSubscription(endpoint: string): boolean;
  /** Record a delivery attempt: success resets the failure count, failure increments it. */
  markPushResult(endpoint: string, ok: boolean): void;
  getVapidKeys(): { publicKey: string; privateKey: string } | null;
  setVapidKeys(k: { publicKey: string; privateKey: string }): void;
  /* --- Google OAuth accounts + reply posting (migration 003) --- */
  listGoogleAccounts(): GoogleAccountRow[];
  upsertGoogleAccount(a: GoogleAccountRow): void;
  updateGoogleAccount(channelId: string, p: Partial<GoogleAccountRow>): void;
  deleteGoogleAccount(channelId: string): void;
  setDefaultGoogleAccount(channelId: string): void;
  /** Insert a reply_posts row with status 'pending'. */
  beginReplyPost(commentId: string, bodyHash: string): number;
  finishReplyPost(
    id: number,
    p: {
      status: 'posted' | 'failed' | 'unknown';
      postedCommentId?: string | null;
      viaChannelId?: string | null;
      error?: string | null;
    },
  ): void;
  /** A 'posted' reply_posts row for this comment+body created at/after sinceIso, if any (double-post guard). */
  recentPostedReply(commentId: string, bodyHash: string, sinceIso: string): { postedCommentId: string } | null;
  /** Was this comment id posted by this app (has a posted reply_posts row)? */
  isAppPostedReply(commentId: string): boolean;
  /**
   * One transaction: save draft as 'posted', triage target -> 'replied' (user-undoable), insert the posted comment
   * via the addReplies path (own + auto-clear), mark the reply_posts row posted.
   */
  recordPostedReply(p: {
    commentId: string;
    body: string;
    posted: YtComment;
    viaChannelId: string;
    replyPostId: number;
  }): {
    actionId: number;
    newCommentIds: string[];
    changedIds: string[];
  };
  /** Remove a locally stored own comment after it was deleted on YouTube. */
  removeLocalComment(commentId: string): void;
  /** Mark a thread as (not) replyable, e.g. after YouTube answers operationNotSupported. */
  setThreadCanReply(threadId: string, canReply: boolean): void;

  getSettings(): StoredSettings;
  updateSettings(p: Partial<StoredSettings>): StoredSettings;

  /* --- feeds and mute rules (migration 008) --- */
  listFeeds(): FeedDTO[];
  getFeed(id: number): FeedDTO | null;
  getFeedRow(id: number): FeedRow | null;
  enabledFeedRows(): FeedRow[];
  addFeed(f: NewFeed): FeedDTO;
  updateFeed(
    id: number,
    p: Partial<{ enabled: boolean; prs: boolean; issues: boolean; importMode: ImportMode }>,
  ): FeedDTO | null;
  deleteFeed(id: number): boolean;
  recordFeedPoll(id: number, r: FeedPollResult): void;
  listMuteRules(): MuteRuleDTO[];
  /** Adds the rule and returns the inbox items it now covers (the caller archives them with triage, so it is undoable). */
  addMuteRule(kind: MuteKind, value: string): { rule: MuteRuleDTO; affectedIds: string[] };
  deleteMuteRule(id: number): boolean;
  /** The provider-neutral card for an item of any provider. */
  getItem(id: string): { item: ItemDTO; state: CommentState; occurredAt: string; bodyPlain: string } | null;
  /** Create a todo straight into the inbox (or snoozed until `dueAt`). Returns its id. */
  addTodo(input: { title: string; notes: string; raw: string; dueAt: string | null }): string;
  /** Remove a todo outright (undoing its creation). Returns whether one was removed. */
  deleteTodo(id: string): boolean;
  githubItemMeta(ids: string[]): Map<string, { state: CommentState; sourceState: string | null; comments: number }>;
  upsertGithubItems(feedId: number, ups: GithubItemUpsert[]): UpsertGithubResult;

  listSources(): SourceDTO[];
  /** Aggregate totals over every tracked, non-missing video. */
  getStats(): StatsDTO;
  /** Ids of tracked videos whose duration has never been fetched (pre-migration rows). */
  videosMissingDetails(): string[];
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
  /**
   * Snooze (until = future ISO) or unsnooze (null) the given comments; only state 'inbox' comments are affected.
   * Snoozing clears wokeAt. triage(ids, 'inbox') also clears a snooze.
   */
  snooze(ids: string[], until: string | null): SnoozeResult;
  undoSnooze(actionId: number): SnoozeResult;
  /** Wake every snooze whose time has passed: snoozedUntil -> null, wokeAt = the old snoozedUntil. Returns woken ids. */
  wakeSnoozed(): { woken: string[]; counts: Counts };
  listLabels(): LabelDTO[];
  createLabel(name: string, color?: LabelColor): LabelDTO;
  updateLabel(id: number, patch: { name?: string; color?: LabelColor; position?: number }): LabelDTO;
  deleteLabel(id: number): void;
  applyLabels(ids: string[], add: number[], remove: number[]): LabelApplyResult;
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

export interface GoogleAccountRow {
  channelId: string;
  title: string | null;
  thumbnailUrl: string | null;
  refreshToken: string;
  accessToken: string | null;
  accessExpiresAt: string | null;
  scope: string;
  connectedAt: string;
  needsReauth: boolean;
  lastError: string | null;
  isDefault: boolean;
}

export type PostErrorCode =
  | 'auth_required'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'cannot_reply'
  | 'comment_gone'
  | 'text_too_long'
  | 'bad_text'
  | 'ineligible_account'
  | 'duplicate_in_flight'
  | 'post_failed'
  | 'post_unconfirmed'
  | 'no_client';
export class PostError extends Error {
  constructor(
    public code: PostErrorCode,
    message: string,
    public status: number,
    public retryable = false,
  ) {
    super(message);
    this.name = 'PostError';
  }
}

/** Thrown by a PostGateway for any failed write call. `network` = the request may or may not have reached Google. */
export class GatewayError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason: string | null,
    public network = false,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
/** OAuth-authorised YouTube write/verification calls. Real impl: fetch; demo impl: fake world; tests: scripted. */
export interface PostGateway {
  /** comments.insert (50 units). parentId must be the top-level comment id. */
  insertReply(token: string, p: { parentId: string; videoId: string; text: string }): Promise<YtComment>;
  /** comments.list?parentId (1 unit), used to verify an ambiguous insert. */
  listReplies(token: string, parentId: string, videoId: string): Promise<YtComment[]>;
  /** comments.delete (50 units). */
  deleteComment(token: string, commentId: string): Promise<void>;
  /** channels.list?mine=true (1 unit) -> the authorised user's channel(s). */
  myChannel(token: string): Promise<{ id: string; title: string; thumbnailUrl: string | null } | null>;
}

export interface GoogleAuth {
  status(): GoogleAuthDTO;
  /** Begin the loopback PKCE flow; returnOrigin is the UI origin to send the browser back to. */
  start(returnOrigin: string): { url: string };
  /** Handle Google's redirect. Never throws for user-facing failures: returns the ?google= code. */
  handleCallback(q: { code?: string; state?: string; error?: string }): Promise<{ returnTo: string; result: string }>;
  /** Valid access token for the channel (default account if omitted); refreshes single-flight. Throws PostError('auth_required'). */
  getAccessToken(channelId?: string): Promise<{ token: string; channelId: string }>;
  disconnect(channelId?: string): Promise<void>;
  setDefault(channelId: string): void;
  /** Connected, non-expired accounts exist. */
  canPost(): boolean;
  /** Channel id that should post for a video owned by videoChannelId (matching account, else default). */
  pickAccount(videoChannelId: string | null): GoogleAccountRow | null;
}

export interface ReplyPoster {
  capabilities(): Capabilities;
  reply(comment: CommentDTO, body: string): Promise<ReplyResult>;
  /**
   * Delete an own reply that this app posted (comments.delete, 50 units) and drop it locally. Absent on pure hand-off
   * posters. Throws PostError.
   */
  deleteReply?(comment: CommentDTO): Promise<void>;
}

/** Everything the HTTP layer needs. */
export type LabelErrorCode = 'duplicate_label' | 'bad_name' | 'not_found' | 'too_many_labels';
export class LabelError extends Error {
  constructor(
    public code: LabelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LabelError';
  }
}

/* ---------------- GitHub (polled; no webhooks, the box is only reachable on the tailnet) ---------------- */
export interface GithubRate {
  limit: number;
  remaining: number;
  resetAt: string;
}
/** A failure talking to GitHub. `retryAt` is set when the cause is a rate limit. */
export class GithubError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAt: string | null = null,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}
export interface GithubSearchPage {
  items: GithubItemUpsert[];
  total: number;
  rate: GithubRate | null;
}
/** Everything the poller needs from GitHub; the real one is a thin fetch wrapper, tests and demo mode fake it. */
/** One thing the assistant decided to do. `due`/`until` are ISO 8601 instants (null: none given). */
export type AssistantAction =
  | { type: 'add_todo'; title: string; notes: string; due: string | null }
  | { type: 'snooze'; until: string }
  | { type: 'done' };
export interface AssistantResult {
  actions: AssistantAction[];
  /** What the assistant said back, if anything (e.g. why it did nothing). */
  reply: string;
}
export class LlmError extends Error {
  constructor(
    message: string,
    public status: number | null = null,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
export interface LlmClient {
  /** Check a key with a tiny call. */
  test(apiKey: string, model: string): Promise<{ ok: boolean; message: string }>;
  /**
   * Turn a spoken or typed command into actions. `now` is the user's local time with its UTC offset, so "Friday" and
   * "in 3 days" resolve in their own time zone. `selected` is the item the user has open, if any: "this" means it.
   */
  command(
    input: { text: string; now: string; selected: { title: string | null; kind: string } | null },
    apiKey: string,
    model: string,
  ): Promise<AssistantResult>;
}
export interface GithubClient {
  /** Who owns this token (GET /user) and the scopes it carries, for the Settings "Test" button. */
  whoami(token: string): Promise<{ login: string; scopes: string[] | null }>;
  ownerType(owner: string, token: string | null): Promise<'org' | 'user' | null>;
  /** One page (up to 100) of /search/issues, oldest update first. */
  search(q: string, page: number, token: string | null): Promise<GithubSearchPage>;
  /** Login of the newest comment on an issue or PR (given its comment count), or null. */
  latestCommenter(repo: string, number: number, commentCount: number, token: string | null): Promise<string | null>;
  /** The conversation on an issue or PR (newest entries only), fetched live. Throws GithubError. */
  discussion(repo: string, number: number, kind: 'pr' | 'issue', token: string | null): Promise<GithubDiscussion>;
}
/** What the client returns; the route adds `fetchedAt`. */
export type GithubDiscussion = Omit<GithubDiscussionDTO, 'fetchedAt'>;
export interface GithubPoller {
  start(): void;
  stop(): void;
  /** Poll every enabled feed now (or just one); resolves when done. */
  pollNow(feedId?: number): Promise<void>;
}

export interface AppDeps {
  repo: Repo;
  engine: SyncEngine;
  bus: EventBus;
  quota: QuotaTracker;
  poster: ReplyPoster;
  auth: GoogleAuth;
  /** Resolve + add a source (and kick off its first sync). */
  addSource(input: string, opts: { importMode?: ImportMode; isOwn?: boolean }): Promise<SourceDTO>;
  /** Check a YouTube API key with a 1-unit call. */
  testKey(apiKey: string): Promise<{ ok: boolean; message: string }>;
  /** Called after settings change (e.g. own channel ids) so the server can react. */
  onSettingsChanged(): void;
  /** Fetch durations/likes for videos stored before those columns existed; resolves to the number updated. */
  backfillDetails?(): Promise<number>;
  /** Web Push (absent in tests that do not exercise it). */
  push?: PushService;
  /** GitHub feeds (absent in tests that do not exercise them). */
  github?: GithubPoller;
  githubClient?: GithubClient;
  /** The assistant (absent in tests that do not exercise it). */
  llm?: LlmClient;
  resolveApiKey(): { key: string | null; source: 'env' | 'settings' | 'file' | null };
  demo: boolean;
  /** Short commit SHA of this server, shown in Settings. */
  version?: string;
  /** Demo mode only: force new comments to appear. */
  demoTick?: () => void;
  staticDir?: string;
}
export type { QuotaDTO, SettingsDTO, InboxItem };

/* ---------------- Web Push ---------------- */
export type PushSendResult = 'ok' | 'gone' | 'error';
export interface PushPayload {
  title: string;
  body: string;
  /** Path to open when tapped (same origin). */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
}
/** Sends one encrypted message to one subscription; the only piece that touches the network. */
export interface PushSender {
  send(sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload): Promise<PushSendResult>;
}
export interface PushService {
  publicKey(): string;
  /** Send a test notification to one subscription. */
  test(endpoint: string): Promise<PushSendResult | 'unknown'>;
  /** Send whatever has been collected now and wait for it (tests; shutdown). */
  flush(): Promise<void>;
  stop(): void;
}
