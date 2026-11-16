// Shared domain + DTO types. This file is the contract between server and web.
// Changes go through the lead only.
import type { SnoozeBucket, WakeCause } from './snooze.js';
export type { SnoozeBucket, WakeCause } from './snooze.js';

export type CommentState = 'inbox' | 'done' | 'replied' | 'auto_replied' | 'resolved' | 'own' | 'archived';
/**
 * Why an item is done. 'no_action' = "no action needed": it behaves exactly like done (same state, leaves the inbox,
 * returns on new activity) but is recorded as a dismissal. Only set while state is 'done'; absent otherwise.
 */
export type DoneReason = 'no_action';
/** What a triage call moves items to. 'dismissed' is state 'done' with doneReason 'no_action'. */
export type TriageTarget = 'done' | 'dismissed' | 'replied' | 'inbox';
/** 'snoozed' = inbox comments hidden until their snoozedUntil; 'inbox' excludes them until they wake. */
export type InboxView = 'inbox' | 'done' | 'all' | 'snoozed';
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
  /** Set when state is 'done' and the owner said no action was needed (a dismissal). */
  doneReason?: DoneReason | null;
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
    /** Login of the newest commenter, known only when the item came back as 'new_activity'. */
    lastCommenter?: string | null;
    /**
     * When it came back as 'new_activity': the last moment Nudge saw the comment count unchanged. Comments after it
     * are the ones that woke the item (they predate the sync that noticed them, so woke_at is too late a cut-off).
     */
    activitySince?: string | null;
  };
}
/** One entry of a pull request's or issue's conversation, normalised from three different GitHub endpoints. */
export interface GithubDiscussionEntry {
  /** Unique within the conversation: "c123" (comment), "r123" (review), "i123" (inline review comment). */
  id: string;
  kind: 'comment' | 'review' | 'inline';
  author: string;
  avatarUrl: string | null;
  /** 'User' | 'Bot' ... as reported by GitHub. */
  authorType: string | null;
  association: GithubAssociation | null;
  createdAt: string;
  /** Markdown, untrusted: render it through the sanitiser only. */
  body: string;
  url: string | null;
  /** Reviews only. */
  reviewState?: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  /** Inline comments only: the file, the line (null once outdated) and the entry id this replies to, if any. */
  path?: string;
  line?: number | null;
  replyTo?: string | null;
}
export interface GithubDiscussionDTO {
  /** Oldest first. */
  entries: GithubDiscussionEntry[];
  /** True when older entries were left out to keep the page small. */
  olderCut: boolean;
  /** ISO time this answer was fetched from GitHub (it may be served from a short cache). */
  fetchedAt: string;
}
/** What the model thinks the owner should do. Advisory only: nothing in Nudge ever acts on it. */
export type SuggestedAction = 'reply' | 'act' | 'skip' | 'spam';
export interface SuggestionDTO {
  /**
   * Null when the model said the text tried to instruct it (`suspicious`): such an item shows a warning and no
   * suggestion, and the model's reason is withheld because it may repeat the attacker's words.
   */
  action: SuggestedAction | null;
  /** One short plain sentence; empty when suspicious. */
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  suspicious: boolean;
  /** Whose move it is now, judged from the current thread; null when the model did not say. */
  turn?: 'matt' | 'them' | 'nobody' | null;
  /** One short sentence about what happens next ("review the proposed fix and merge"); null when none. */
  nextStep?: string | null;
}
export type InboxOrder = 'newest' | 'oldest' | 'arrived' | 'source';
export interface InboxItem {
  item: ItemDTO;
  /**
   * For YouTube the real comment. For other providers a comment-shaped stand-in (id, author, text, state) so the
   * shared triage code (selection, snooze, undo) keeps working unchanged.
   */
  comment: CommentDTO;
  video: Pick<VideoDTO, 'id' | 'title' | 'thumbnailUrl'>;
  /** Context for replies (null for top-level comments). */
  parent: Pick<CommentDTO, 'id' | 'authorName' | 'textPlain' | 'isOwn'> | null;
  /** When Nudge first saw it (not when it was written): what the "recently arrived" order sorts by. */
  arrivedAt: string;
  threadReplyCount: number;
  hasDraft: boolean;
  /** ISO time the comment is snoozed until (future), or null. A past value never reaches the client: it is woken. */
  snoozedUntil: string | null;
  /** When the last snooze ended. Inbox ordering uses COALESCE(wokeAt, comment.publishedAt) so woken items resurface. */
  wokeAt: string | null;
  /** Why the owner snoozed it, in his words: set while it is snoozed and after it wakes (null when he gave none). */
  snoozeWhy: string | null;
  /** The reason bucket chosen (or inferred) when it was snoozed; shown while snoozed and after it wakes. */
  snoozeBucket: SnoozeBucket | null;
  /** Snoozed until someone else acts, with `snoozedUntil` as the fallback date. False once it is not snoozed. */
  snoozeUntilActivity: boolean;
  /** When the current/last snooze started (the Snoozed view shows ages from it). */
  snoozedAt: string | null;
  /** What ended the last snooze, when it was an until-activity one; null when it was a plain timed snooze. */
  wakeCause: WakeCause | null;
  /** Set on an item that came back because the fallback date arrived with no activity: the audit line's facts. */
  snoozeNag: { bucket: SnoozeBucket | null; days: number } | null;
  /** The current LLM suggestion, or null while there is none (no key, not classified yet, or a todo). */
  suggestion: SuggestionDTO | null;
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
  /**
   * The GitHub user or organisation whose pull requests and issues arrive here; for a 'repo' feed, the single
   * repository as "owner/name".
   */
  owner: string;
  /** 'owner': every repository of a user or organisation. 'repo': one repository. */
  kind: 'owner' | 'repo';
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
export type MuteKind = 'repo' | 'owner' | 'author' | 'bots' | 'item';
export interface MuteRuleDTO {
  id: number;
  kind: MuteKind;
  /** repo: "owner/repo"; owner: the part before the slash; author: a login; bots: ""; item: an item id. */
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
  | {
      type: 'snooze';
      id: string;
      until: string;
      why: string | null;
      bucket: SnoozeBucket | null;
      untilActivity: boolean;
      undoActionId: number | null;
    }
  | { type: 'note'; id: number; scope: NoteScope; text: string; itemId: string | null }
  | { type: 'done'; id: string; undoActionId: number | null }
  | { type: 'dismissed'; id: string; undoActionId: number | null };
export type NoteScope = 'item' | 'standing';
/** One thing the owner told the assistant. Everything but `text` and `enabled` is a snapshot taken at the time. */
export interface NoteDTO {
  id: number;
  createdAt: string;
  text: string;
  /** What was first said, when the text has been edited since. */
  originalText: string;
  scope: NoteScope;
  /** False: kept on record but no longer shown to the model. */
  enabled: boolean;
  source: 'voice' | 'text';
  itemId: string | null;
  itemTitle: string | null;
  /** The suggestion that was showing for the item when the note was made. */
  suggestion: {
    verdict: string;
    /** The verdict as the chip names it: reply, act, skip or spam. */
    action: string;
    turn: string | null;
    nextStep: string | null;
    reason: string;
    confidence: string;
  } | null;
  /** The owner's latest action on the item in the hour before: what he did, and the why he gave. */
  lastAction: { kind: 'state' | 'snooze'; to: string | null; at: string; why: string | null } | null;
  context: {
    provider: string;
    kind: string;
    container: string | null;
    author: string | null;
    comments: number | null;
    lastCommenter: string | null;
  } | null;
}
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
  /** Days an "until activity" snooze waits before it comes back anyway, per reason bucket. */
  snoozeDays: Record<SnoozeBucket, number>;
  demo: boolean;
  /** Commit of the running server (short SHA), or 'dev'. */
  version: string;
  github: GithubSettingsDTO;
  llm: LlmSettingsDTO;
  google: GoogleAuthDTO;
  /** Adventure mode (docs/RPG.md): a cosmetic level/title layer. Off hides it all and stops the /api/rpg calls. */
  rpg: RpgSettingsDTO;
}
export interface RpgSettingsDTO {
  enabled: boolean;
  /** A short chime on a level-up toast. */
  sound: boolean;
  /** The level whose title the chip shows (an earned one); null = the current level's. */
  title: number | null;
}

/* ---------------- Adventure mode (cosmetic only; see docs/RPG.md) ---------------- */
export interface RpgAchievementDTO {
  id: string;
  /** The base name (the Hall adds the tier's numeral). Null while a hidden achievement is unearned: "???". */
  name: string | null;
  /** What the next tier takes, or the top tier's once all are earned. Null while hidden. */
  description: string | null;
  hidden: boolean;
  /** At least one tier earned. */
  earned: boolean;
  /** Tiers earned (0 = none) out of `tiers`; a one-off has a single tier. */
  tier: number;
  tiers: number;
  /** The day the current tier was earned (YYYY-MM-DD in the browser's time zone), when known. */
  earnedOn: string | null;
  /** For a ladder: how far towards the next tier (shown in the Hall only). Null for one-offs and finished ladders. */
  progress: { n: number; of: number } | null;
}
export interface RpgBossDTO {
  id: string;
  name: string;
  who: string;
  line: string;
  /** How many times it has fallen (0 = still at large). */
  defeated: number;
  /** The day it first fell (YYYY-MM-DD). */
  firstOn: string | null;
}
export interface RpgLootDTO {
  id: string;
  name: string;
  description: string;
  earned: boolean;
  /** How many times, for the ones that can happen again (lantern, cloak, hat...). */
  times: number;
}
export interface RpgSheet {
  /** Today (YYYY-MM-DD) in the time zone the sheet was worked out for. */
  day: string;
  xp: number;
  level: number;
  /** The level's own title. */
  levelTitle: string;
  /** What the chip shows: the chosen earned title, else the level's. */
  title: string;
  /** XP at which this level started and the next one starts. */
  levelXp: number;
  nextLevelXp: number;
  /** Today's decoration (days in the browser's time zone). */
  today: { cloak: boolean; lantern: boolean; hat: boolean; flame: boolean };
  /**
   * The campfire: good days in the current run (0 when it is out) and the longest run. One missed day per run is
   * covered by a rest day, earned back after a few good days; `notice` is the latest miss worth a kind word.
   */
  campfire: {
    current: number;
    longest: number;
    restUsed: boolean;
    goodToRestore: number;
    notice: RpgCampfireNotice | null;
  };
  accent: 'default' | 'phosphor' | 'amber';
  achievements: RpgAchievementDTO[];
  bosses: RpgBossDTO[];
  loot: RpgLootDTO[];
  /** Worthless finds, newest first (at most 30), with the day each was found. */
  lootLog: { name: string; on: string }[];
  /** Titles earned so far, for the picker. */
  titles: { level: number; title: string }[];
  chosenTitle: number | null;
  /** Items that have paid anything, and how. */
  tally: { payouts: number; replies: number; dones: number; dismissals: number };
}
/** What this device should announce now (each thing is announced once, on one device). */
export interface RpgNews {
  /** First switch-on: "You arrive as a Level N ...". Nothing earlier is replayed. */
  arrive: { level: number; title: string } | null;
  /**
   * The game was rebalanced since the last claim (docs/RPG.md, "Rebalancing"): one quiet line with the level now, in
   * place of anything else this once. Nothing earned before is replayed.
   */
  rebalanced: { level: number; title: string } | null;
  levelUp: { from: number; to: number; title: string } | null;
  /** `name` carries the tier's numeral for a ladder ("Rubber Duck II"); only the highest new tier is listed. */
  achievements: { id: string; name: string; tier: number }[];
  bosses: { id: string; name: string; line: string }[];
  loot: { id: string; name: string; line: string }[];
  /** A missed day, the first time it is noticed. */
  campfire: RpgCampfireNotice | null;
}
/** A missed campfire day (YYYY-MM-DD): covered by the rest day, or the one that put the fire out. */
export interface RpgCampfireNotice {
  kind: 'forgiven' | 'out';
  day: string;
}
export interface RpgClaim {
  sheet: RpgSheet;
  news: RpgNews;
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
export type ReplyResult =
  { mode: 'handoff'; url: string; actionId: number } | { mode: 'posted'; comment: CommentDTO; actionId: number };
export interface Bootstrap {
  settings: SettingsDTO;
  capabilities: Capabilities;
  counts: Counts;
  sources: SourceDTO[];
  quota: QuotaDTO;
  sync: SyncStatus;
  feeds: FeedDTO[];
  mutes: MuteRuleDTO[];
  /** Absent when the server has no suggestion worker. */
  suggestStatus?: SuggestStatusDTO;
}
/** How far the suggestion worker has got through the inbox, and why it is waiting if it is. */
export interface SuggestStatusDTO {
  /** False when there is no assistant key: nothing will be classified. */
  enabled: boolean;
  /** Inbox items that can have a suggestion (YouTube and GitHub, awake, not mine). */
  total: number;
  /** Of those, how many have a current suggestion. */
  done: number;
  /** A pass is running right now. */
  working: boolean;
  /**
   * Why it is not working through the rest: the daily cost cap (until the next UTC midnight), GitHub's rate limit (until
   * it resets: only items that need a thread fetch wait), a back-off after errors, or a rejected key.
   */
  paused: { reason: 'cap' | 'rate-limit' | 'backoff' | 'key-rejected'; until: string | null } | null;
  /** Items held back (not classified at all yet) because their thread cannot be fetched until GitHub's limit resets. */
  waitingForThread: number;
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
  /** Suggestions arrived or were replaced; a null value means the item no longer has one. Patch rows in place. */
  | { type: 'suggestions.changed'; suggestions: Record<string, SuggestionDTO | null> }
  /** Progress of the background suggestion worker (throttled). */
  | { type: 'suggestions.status'; status: SuggestStatusDTO }
  /** The owner's notes changed (made, edited, switched off or deleted): the full list, newest first. */
  | { type: 'notes.changed'; notes: NoteDTO[] }
  | { type: 'sync.progress'; status: SyncStatus }
  | { type: 'sync.done'; summary: SyncRunSummary }
  | { type: 'quota.update'; quota: QuotaDTO }
  | { type: 'sources.changed'; sources: SourceDTO[] }
  | { type: 'feeds.changed'; feeds: FeedDTO[]; mutes: MuteRuleDTO[] }
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
