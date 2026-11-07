import type * as T from './types.js';

export interface InboxQuery {
  view: T.InboxView;
  sourceId?: number;
  videoId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}
export interface InboxPage {
  items: T.InboxItem[];
  nextCursor: string | null;
  total: number;
}
export type SyncScope = 'all' | 'source' | 'video';
export interface SyncRequest {
  scope: SyncScope;
  id?: string | number;
  deep?: boolean;
}
export interface SettingsUpdate {
  apiKey?: string | null;
  ownChannelIds?: string[];
  pollEnabled?: boolean;
  dailyQuotaBudget?: number;
  manualReserve?: number;
  backfillDays?: number;
  theme?: 'system' | 'light' | 'dark';
}
export interface DraftDTO {
  body: string;
  updatedAt: string;
  status: 'draft' | 'handed_off' | 'posted';
}

/** Every request from the web app must carry this header (CSRF guard). */
export const CLIENT_HEADER = 'X-Youtubey';

/**
 * REST surface (all JSON, under /api). Documented here as the contract:
 *
 * GET    /api/bootstrap                         -> Bootstrap
 * GET    /api/inbox?view&sourceId&videoId&q&cursor&limit -> InboxPage
 * GET    /api/threads/:threadId?focus=commentId -> ThreadDetail
 * POST   /api/triage {commentIds, to:'done'|'replied'|'inbox'} -> TriageResult
 * POST   /api/triage/:actionId/undo             -> TriageResult
 * GET    /api/drafts/:commentId                 -> DraftDTO | 404
 * PUT    /api/drafts/:commentId {body}          -> DraftDTO
 * DELETE /api/drafts/:commentId                 -> 204
 * POST   /api/comments/:id/reply {body}         -> ReplyResult
 * GET    /api/sources                           -> SourceDTO[]
 * POST   /api/sources {input, importMode?, isOwn?} -> 201 SourceDTO
 * POST   /api/sources/preview {input}           -> {kind, ytId} | 400
 * PATCH  /api/sources/:id {enabled?,isOwn?,title?,importMode?} -> SourceDTO
 * DELETE /api/sources/:id?purge=1               -> 204
 * GET    /api/sources/:id/videos                -> VideoDTO[]
 * PATCH  /api/videos/:id {tierOverride}         -> VideoDTO
 * POST   /api/sync SyncRequest                  -> 202 SyncStatus
 * GET    /api/sync/status                       -> SyncStatus
 * GET    /api/quota                             -> QuotaDTO
 * GET    /api/settings                          -> SettingsDTO
 * PUT    /api/settings SettingsUpdate           -> SettingsDTO
 * POST   /api/settings/own-channels {input, importMode?} -> SettingsDTO. input = channel URL, @handle or UC id; resolves it via
 *                                                  YouTube (404 if unknown, 400 if not a channel), registers it as mine
 *                                                  and tracks it as an isOwn channel source.
 * DELETE /api/settings/own-channels/:channelId  -> SettingsDTO. Un-marks the source isOwn; tracking continues.
 * POST   /api/settings/test-key {apiKey?}       -> {ok, message}
 * GET    /api/events                            -> SSE; `event: <ServerEvent.type>`, `data: JSON(ServerEvent)`
 * POST   /api/demo/tick                         -> 204 (demo mode only)
 * Errors: non-2xx with ApiError JSON.
 */
