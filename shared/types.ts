// Shared domain + DTO types. This file is the contract between server and web.
// Changes go through the lead only.
export type CommentState = 'inbox' | 'done' | 'replied' | 'auto_replied' | 'own' | 'archived';
export type InboxView = 'inbox' | 'done' | 'all';
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
export interface InboxItem {
  comment: CommentDTO;
  video: Pick<VideoDTO, 'id' | 'title' | 'thumbnailUrl'>;
  /** Context for replies (null for top-level comments). */
  parent: Pick<CommentDTO, 'id' | 'authorName' | 'textPlain' | 'isOwn'> | null;
  threadReplyCount: number;
  hasDraft: boolean;
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
  bySource: Record<number, number>;
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
}
export interface Capabilities {
  canPost: boolean;
  postMode: 'handoff' | 'api';
}
export interface TriageResult {
  actionId: number;
  changes: { commentId: string; from: CommentState; to: CommentState }[];
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
}
export type ServerEvent =
  | { type: 'inbox.changed'; counts: Counts; addedIds: string[]; changedIds: string[] }
  | { type: 'sync.progress'; status: SyncStatus }
  | { type: 'sync.done'; summary: SyncRunSummary }
  | { type: 'quota.update'; quota: QuotaDTO }
  | { type: 'sources.changed'; sources: SourceDTO[] }
  | { type: 'settings.changed'; settings: SettingsDTO }
  | { type: 'error'; message: string; sourceId?: number; videoId?: string };
export interface ApiError {
  error: string;
  code: string;
}
