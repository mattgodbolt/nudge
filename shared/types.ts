// Shared domain + DTO types. This file is the contract between server and web.
// Changes go through the lead only.
export type CommentState = 'inbox' | 'done' | 'replied' | 'auto_replied' | 'resolved' | 'own' | 'archived';
/** 'snoozed' = inbox comments hidden until their snoozedUntil; 'inbox' excludes them until they wake. */
export type InboxView = 'inbox' | 'done' | 'all' | 'snoozed';
/** Label colours are named tokens (the web maps them to CSS colours for light and dark themes). */
export const LABEL_COLORS = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink', 'gray'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];
export const MAX_LABEL_NAME = 40;
export const MAX_LABELS = 100;
export interface LabelDTO {
  id: number;
  name: string;
  color: LabelColor;
  /** Sidebar order, ascending. */
  position: number;
}
export type SourceKind = 'channel' | 'playlist' | 'video';
export type PollTier = 'hot' | 'warm' | 'cold' | 'frozen' | 'paused';
export type ImportMode = 'none' | 'recent' | 'all';

export interface CommentDTO {
  id: string;
  threadId: string;
  parentId: string | null;
  videoId: string;
  authorName: string;
  authorChannelId: string | null;
  authorAvatarUrl: string | null;
  textHtml: string;
  textPlain: string;
  likeCount: number;
  publishedAt: string;
  updatedAt: string;
  isOwn: boolean;
  state: CommentState;
  stateSource: 'sync' | 'user' | 'auto';
  permalink: string;
  /** Own comment that this app posted through the API (so it can be deleted from here). */
  postedByApp?: boolean;
}
export interface VideoDTO {
  id: string;
  title: string;
  channelId: string | null;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  commentCount: number | null;
  commentsDisabled: boolean;
  missing: boolean;
  tier: PollTier;
  tierOverride: PollTier | null;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  inboxCount: number;
}
export type ItemProvider = 'youtube' | 'github' | 'todo';
export type ItemKind = 'comment' | 'pr' | 'issue' | 'todo';
/** GitHub's relationship between the author and the repository (the REST `author_association` field). */
export type GithubAssociation =
  'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR' | 'FIRST_TIME_CONTRIBUTOR' | 'FIRST_TIMER' | 'MANNEQUIN' | 'NONE';
/** Provider-neutral view of one triage item. Everything the list row and header need, whatever the source. */
export interface ItemDTO {
  id: string;
  provider: ItemProvider;
  kind: ItemKind;
  title: string | null;
  author: string | null;
  authorAvatarUrl: string | null;
  isOwn: boolean;
  /** "Open on <provider>" target. */
  url: string | null;
  /** Grouping: a video id, or "owner/repo". */
  containerKey: string | null;
  containerTitle: string | null;
  containerUrl: string | null;
  /** The provider's own state: 'open' | 'closed' | 'merged'. Null for YouTube. */
  sourceState: string | null;
  /** Why it is (back) in the inbox: 'new' | 'new_activity' | 'reopened' | 'muted'. */
  reason: string | null;
  /** Covered by a mute rule or muted on its own: it never reopens or notifies. */
  muted: boolean;
  /** A todo: what was said (verbatim). The notes are the item body. */
  todo?: { raw: string };
  github?: {
    owner: string;
    repo: string;
    number: number;
    draft: boolean;
    association: GithubAssociation | null;
    /** 'User' | 'Bot' | 'Organization' ... as reported by GitHub. */
    authorType: string | null;
    comments: number;
    labels: string[];
    createdAt: string;
  };
}
export type InboxOrder = 'newest' | 'oldest' | 'arrived' | 'source';
export interface InboxItem {
  item: ItemDTO;
  /**
   * For YouTube the real comment. For other providers a comment-shaped stand-in (id, author, text, state) so the
   * shared triage code (selection, snooze, labels, undo) keeps working unchanged.
   */
  comment: CommentDTO;
  video: Pick<VideoDTO, 'id' | 'title' | 'thumbnailUrl'>;
  /** Context for replies (null for top-level comments). */
  parent: Pick<CommentDTO, 'id' | 'authorName' | 'textPlain' | 'isOwn'> | null;
  /** When Nudge first saw it (not when it was written): what the "recently arrived" order sorts by. */
  arrivedAt: string;
  threadReplyCount: number;
  hasDraft: boolean;
  /** Ids of the labels on this comment. */
  labels: number[];
  /** ISO time the comment is snoozed until (future), or null. A past value never reaches the client: it is woken. */
  snoozedUntil: string | null;
  /** When the last snooze ended. Inbox ordering uses COALESCE(wokeAt, comment.publishedAt) so woken items resurface. */
  wokeAt: string | null;
}
export interface ThreadDetail {
  threadId: string;
  video: VideoDTO;
  canReply: boolean;
  /** Top-level first, then replies chronological. */
  comments: CommentDTO[];
  totalReplyCount: number;
}
export interface SourceDTO {
  id: number;
  kind: SourceKind;
  ytId: string;
  title: string | null;
  thumbnailUrl: string | null;
  isOwn: boolean;
  enabled: boolean;
  importMode: ImportMode;
  addedAt: string;
  videoCount: number;
  inboxCount: number;
  lastError: string | null;
  projectedUnitsPerDay: number;
}
export interface Counts {
  inbox: number;
  done: number;
  all: number;
  /** Inbox comments currently hidden by a snooze. `inbox` and `bySource` exclude these. */
  snoozed: number;
  bySource: Record<number, number>;
  /** Comments with each label that need attention (state inbox, not snoozed). Every label has an entry (0 if none). */
  byLabel: Record<number, number>;
  /** Inbox items per non-YouTube feed. */
  byFeed: Record<number, number>;
  /** Inbox items per GitHub repository ("owner/repo"); repositories with nothing waiting are absent. */
  byRepo: Record<string, number>;
  /** Todos waiting in the inbox. */
  todos: number;
}

export type FeedProvider = 'github';
export interface FeedDTO {
  id: number;
  provider: FeedProvider;
  /** The GitHub user or organisation whose pull requests and issues arrive here. */
  owner: string;
  ownerType: 'org' | 'user' | null;
  prs: boolean;
  issues: boolean;
  enabled: boolean;
  importMode: ImportMode;
  addedAt: string;
  lastPolledAt: string | null;
  nextPollAt: string | null;
  lastError: string | null;
  rate: { limit: number; remaining: number; resetAt: string } | null;
  inboxCount: number;
  itemCount: number;
}
export type MuteKind = 'repo' | 'author' | 'bots' | 'item';
export interface MuteRuleDTO {
  id: number;
  kind: MuteKind;
  /** repo: "owner/repo"; author: a login; bots: ""; item: an item id. */
  value: string;
  createdAt: string;
}
export interface GithubSettingsDTO {
  configured: boolean;
  last4: string | null;
  /** Logins that are "me" (my own account and any agent accounts): their items never reach the inbox. */
  myAccounts: string[];
}
/** What the assistant did for one command: enough to describe it and to undo it. */
export type AssistantOutcome =
  | { type: 'add_todo'; id: string; title: string; due: string | null }
  | { type: 'snooze'; id: string; until: string; undoActionId: number | null }
  | { type: 'done'; id: string; undoActionId: number | null };
export interface AssistantResponse {
  outcomes: AssistantOutcome[];
  /** What the assistant said back (e.g. why it did nothing). */
  reply: string;
  /** Set when the words were saved as a plain todo because the assistant was off or failed. */
  fallback: 'off' | 'failed' | null;
  error: string | null;
}
export interface LlmSettingsDTO {
  configured: boolean;
  last4: string | null;
  model: string;
}
export interface StatsTotals {
  videos: number;
  /** Videos whose duration/likes are known; fewer than `videos` until the one-off backfill has run. */
  videosWithDetails: number;
  durationSeconds: number;
  views: number;
  videoLikes: number;
  /** Comment totals as reported by YouTube (includes replies), vs what we have synced locally. */
  commentsOnYoutube: number;
  commentsSynced: number;
  /** Likes on other people's comments that we have synced. */
  commentLikes: number;
  /** Replies written by your own channels, among the synced comments. */
  ownReplies: number;
  inbox: number;
}
export interface StatsSourceRow extends Pick<StatsTotals, 'videos' | 'durationSeconds' | 'views' | 'videoLikes'> {
  sourceId: number;
  kind: SourceKind;
  title: string;
  isOwn: boolean;
  commentsOnYoutube: number;
  commentsSynced: number;
  commentLikes: number;
}
export interface StatsDTO {
  totals: StatsTotals;
  /** Same totals restricted to videos from your own channels. */
  mine: StatsTotals;
  bySource: StatsSourceRow[];
}

export interface QuotaDTO {
  dayPt: string;
  used: number;
  budget: number;
  reserve: number;
  blockedUntil: string | null;
}
export interface SyncRunSummary {
  id: number;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  units: number;
  videos: number;
  newComments: number;
  error: string | null;
}
export interface SyncStatus {
  running: boolean;
  runId: number | null;
  trigger: string | null;
  done: number;
  total: number;
  currentVideoId: string | null;
  lastRun: SyncRunSummary | null;
}
export interface GoogleAccountDTO {
  channelId: string;
  title: string | null;
  thumbnailUrl: string | null;
  connectedAt: string;
  needsReauth: boolean;
  lastError: string | null;
  isDefault: boolean;
}
export interface GoogleAuthDTO {
  clientConfigured: boolean;
  clientSource: 'env' | 'settings' | 'file' | null;
  /** The loopback redirect URI the OAuth client must allow (shown in Settings for the web-client fallback). */
  redirectUri: string;
  accounts: GoogleAccountDTO[];
}
export interface SettingsDTO {
  apiKey: { configured: boolean; source: 'env' | 'settings' | 'file' | null; last4: string | null };
  ownChannelIds: string[];
  /** Same channels as ownChannelIds, with display info from the tracked channel source (null if untracked). */
  ownChannels: { id: string; title: string | null; thumbnailUrl: string | null }[];
  pollEnabled: boolean;
  dailyQuotaBudget: number;
  manualReserve: number;
  backfillDays: number;
  theme: 'system' | 'light' | 'dark';
  demo: boolean;
  /** Commit of the running server (short SHA), or 'dev'. */
  version: string;
  github: GithubSettingsDTO;
  llm: LlmSettingsDTO;
  google: GoogleAuthDTO;
}
export interface Capabilities {
  canPost: boolean;
  postMode: 'handoff' | 'api';
  /** Channel replies are posted as by default (api mode only). */
  postAs?: { channelId: string; title: string | null } | null;
}
export interface TriageResult {
  actionId: number;
  changes: { commentId: string; from: CommentState; to: CommentState }[];
  counts: Counts;
}
export interface SnoozeResult {
  /** Undo handle (POST /api/snooze/:actionId/undo); null when nothing changed. */
  actionId: number | null;
  /** Only comments that actually changed. `from`/`to` are snoozedUntil values (null = not snoozed). */
  changes: { commentId: string; from: string | null; to: string | null }[];
  counts: Counts;
}
export interface LabelApplyResult {
  /** Full label-id list for every comment whose labels changed. */
  labels: Record<string, number[]>;
  counts: Counts;
}
export type ReplyResult =
  { mode: 'handoff'; url: string; actionId: number } | { mode: 'posted'; comment: CommentDTO; actionId: number };
export interface Bootstrap {
  settings: SettingsDTO;
  capabilities: Capabilities;
  counts: Counts;
  labels: LabelDTO[];
  sources: SourceDTO[];
  quota: QuotaDTO;
  sync: SyncStatus;
  feeds: FeedDTO[];
  mutes: MuteRuleDTO[];
}
export type ServerEvent =
  | {
      type: 'inbox.changed';
      counts: Counts;
      addedIds: string[];
      changedIds: string[];
      /** Why ids were added, when it is a genuine arrival: 'sync' = new on YouTube, 'woke' = a snooze ended. Push notifications key off this. */
      reason?: 'sync' | 'woke';
    }
  | { type: 'sync.progress'; status: SyncStatus }
  | { type: 'sync.done'; summary: SyncRunSummary }
  | { type: 'quota.update'; quota: QuotaDTO }
  | { type: 'sources.changed'; sources: SourceDTO[] }
  | { type: 'feeds.changed'; feeds: FeedDTO[]; mutes: MuteRuleDTO[] }
  | { type: 'labels.changed'; labels: LabelDTO[] }
  | { type: 'settings.changed'; settings: SettingsDTO }
  | { type: 'capabilities.changed'; capabilities: Capabilities }
  | { type: 'error'; message: string; sourceId?: number; videoId?: string };
export interface ApiError {
  error: string;
  code: string;
}

/* ---------------- Web Push ---------------- */
export interface PushPrefs {
  /** Notify when new comments arrive. */
  newComments: boolean;
  /** Notify when a snoozed comment comes back. */
  snoozeWake: boolean;
}
export interface PushConfigDTO {
  /** VAPID public key (base64url) for pushManager.subscribe({applicationServerKey}). */
  publicKey: string;
}
/** What the browser's PushSubscription.toJSON() gives us. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface PushStateDTO {
  subscribed: boolean;
  prefs: PushPrefs;
}
