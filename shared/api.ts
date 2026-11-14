import type * as T from './types.js';

export interface InboxQuery {
  view: T.InboxView;
  sourceId?: number;
  videoId?: string;
  /** Only comments carrying this label. With view 'all' this is the label's folder (every state except own). */
  labelId?: number;
  /** Only items from this non-YouTube feed. */
  feedId?: number;
  /** Only items in this repository ("owner/repo"). */
  repo?: string;
  /** Only this kind of item. */
  kind?: 'pr' | 'issue' | 'todo';
  /** GitHub author filter: outside contributors, the team, past contributors, bots, or any human. */
  audience?: 'outside' | 'team' | 'contributors' | 'bots' | 'people';
  /**
   * newest: latest activity first (default); oldest: the reverse; arrived: most recently landed in Nudge first;
   * source: Todos, then GitHub, then YouTube, newest first within each.
   */
  order?: T.InboxOrder;
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
  /** GitHub: the token (null removes it) and which logins are me. */
  github?: { token?: string | null; myAccounts?: string[] };
  /** The assistant (Anthropic): API key (null removes it) and model. */
  llm?: { apiKey?: string | null; model?: string };
  /** Google OAuth client: pasted JSON from the console, explicit fields, or null to remove. */
  googleClient?: { json: string } | { clientId: string; clientSecret: string } | null;
}
export interface DraftDTO {
  body: string;
  updatedAt: string;
  status: 'draft' | 'handed_off' | 'posted';
}

/** Every request from the web app must carry this header (CSRF guard). */
export const CLIENT_HEADER = 'X-Nudge';

/**
 * REST surface (all JSON, under /api). Documented here as the contract:
 *
 * GET    /api/bootstrap                         -> Bootstrap
 * GET    /api/inbox?view&sourceId&videoId&q&cursor&limit -> InboxPage
 * GET    /api/threads/:threadId?focus=commentId -> ThreadDetail
 * POST   /api/triage {commentIds, to:'done'|'replied'|'inbox'} -> TriageResult
 * POST   /api/triage/:actionId/undo             -> TriageResult
 * POST   /api/snooze {commentIds, until: ISO|null, why?: string} -> SnoozeResult. `why` (max 200 chars, optional) is the
 *                                                  owner's one-line reason, kept on the item and on the snooze event. Only comments in state inbox change. `until` must be a
 *                                                  future ISO time within a year (400 bad_until); null unsnoozes.
 * POST   /api/snooze/:actionId/undo             -> SnoozeResult (409 cannot_undo, as triage undo)
 * GET    /api/labels                            -> LabelDTO[]
 * POST   /api/labels {name, color?}             -> 201 LabelDTO. 409 duplicate_label (case-insensitive), 400 bad_name
 *                                                  (empty or > MAX_LABEL_NAME), 409 too_many_labels
 * PATCH  /api/labels/:id {name?, color?, position?} -> LabelDTO
 * DELETE /api/labels/:id                        -> 204 (the label is removed from every comment)
 * POST   /api/labels/apply {commentIds, add?: number[], remove?: number[]} -> LabelApplyResult. Idempotent.
 *   Label endpoints emit `labels.changed`; anything that changes counts emits `inbox.changed`.
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
 * GET    /api/stats                             -> StatsDTO (totals over every tracked video; `mine` = your own channels)
 * POST   /api/stats/refresh                     -> StatsDTO (fetches duration/likes for videos stored before they were tracked;
 *                                                  ~1 quota unit per 50 videos)
 * GET    /api/settings                          -> SettingsDTO
 * PUT    /api/settings SettingsUpdate           -> SettingsDTO
 * POST   /api/settings/own-channels {input, importMode?} -> SettingsDTO. input = channel URL, @handle or UC id; resolves it via
 *                                                  YouTube (404 if unknown, 400 if not a channel), registers it as mine
 *                                                  and tracks it as an isOwn channel source.
 * DELETE /api/settings/own-channels/:channelId  -> SettingsDTO. Un-marks the source isOwn; tracking continues.
 * POST   /api/settings/test-key {apiKey?}       -> {ok, message}
 * GET    /api/notes                             -> NoteDTO[] (newest first)
 * PATCH  /api/notes/:id {text?, scope?, enabled?} -> NoteDTO. `enabled: false` keeps the note on record but stops
 *                                                  feeding it to the suggestion model.
 * DELETE /api/notes/:id                         -> 204
 * POST   /api/assistant {text, now, selectedId, via?: 'voice'|'text'} -> AssistantResponse (may record a note)
 *   Note endpoints emit `notes.changed`.
 * GET    /api/events                            -> SSE; `event: <ServerEvent.type>`, `data: JSON(ServerEvent)`
 * GET    /api/auth/status                       -> GoogleAuthDTO
 * POST   /api/auth/start {}                     -> {url} (400 no_client); browser then navigates to url
 * GET    /api/auth/callback?code&state&error    -> 302 to <returnOrigin>/settings?google=connected|<errorcode> (Host-checked only)
 * POST   /api/auth/logout {channelId?}          -> GoogleAuthDTO (revokes at Google, deletes tokens)
 * POST   /api/auth/default {channelId}          -> GoogleAuthDTO
 * POST   /api/comments/:id/delete               -> 204 (deletes an own reply that this app posted; comments.delete, 50 units)
 * POST   /api/demo/tick                         -> 204 (demo mode only)
 * POST   /api/item-events {events:[{kind:'decision'|'open', itemId, at?, to?, meta?}]} -> ItemEventsPostResult. At most
 *   100 per request. Private context for learning the owner's triage habits: `decision` is what was decided about an
 *   item and what was on screen; `open` is an item's detail being opened (meta.dwellMs when closed). Stored as
 *   item_events rows with source 'user'. Unknown item ids are skipped (counted in `rejected`), meta keys outside the
 *   allow-list in ITEM_EVENT_META are dropped, `at` outside the last 24h (or in the future) becomes now.
 * Errors: non-2xx with ApiError JSON. Reply-posting codes: auth_required(401) quota_exhausted(429) rate_limited(429)
 *   cannot_reply(422) comment_gone(404) text_too_long(400) bad_text(400) ineligible_account(403)
 *   duplicate_in_flight(409) post_failed(502) post_unconfirmed(502).
 */

/** What the browser may report through POST /api/item-events. */
export const ITEM_EVENT_KINDS = ['decision', 'open'] as const;
export type ClientItemEventKind = (typeof ITEM_EVENT_KINDS)[number];
export const ITEM_EVENT_INPUTS = ['key', 'button', 'palette', 'touch', 'other'] as const;
export type ItemEventInput = (typeof ITEM_EVENT_INPUTS)[number];
export const MAX_ITEM_EVENTS_PER_REQUEST = 100;

export interface ItemEventPost {
  kind: ClientItemEventKind;
  itemId: string;
  /** ISO time of the event; must be within the last 24h, else the server uses its own clock. */
  at?: string;
  /** decision: the action the API call carried; open: the view it was opened from. */
  to?: string;
  meta?: {
    view?: string;
    rank?: number | null;
    listSize?: number;
    above?: string[];
    input?: ItemEventInput;
    bulk?: boolean;
    selectionSize?: number;
    dwellMs?: number;
  };
}
export interface ItemEventsPostResult {
  accepted: number;
  /** Events dropped: unknown item, bad kind, or unusable shape. */
  rejected: number;
}
