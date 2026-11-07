import { createHash } from 'node:crypto';
import {
  GatewayError,
  PostError,
  type GoogleAuth,
  type PostGateway,
  type QuotaTracker,
  type Repo,
  type ReplyPoster,
  type YtComment,
} from '../contracts.js';
import { htmlToPlain } from '../db/text.js';
import { setOwnChannelId } from '../sync/own-channels.js';

/**
 * Hand-off poster: we never talk to YouTube. The browser copies the text and opens the
 * comment permalink; the server just records the hand-off (draft status, replied state,
 * undoable triage action).
 */
export function createHandoffPoster(repo: Repo): ReplyPoster {
  return {
    capabilities: () => ({ canPost: false, postMode: 'handoff' }),
    async reply(comment, body) {
      const result = repo.markHandedOff(comment.id, body);
      return { mode: 'handoff', url: comment.permalink, actionId: result.actionId };
    },
  };
}

const MAX_TEXT = 10_000;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const VERIFY_SKEW_MS = 5_000;
const INSERT_UNITS = 50;
const DELETE_UNITS = 50;
/** Node error codes that prove the request never left this machine, so a single retry cannot double-post. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Translate a definite (non-ambiguous) Google failure into our PostError. Ambiguous ones are handled by the caller. */
export function mapGatewayError(e: GatewayError): PostError {
  const { status, reason } = e;
  if (status === 401 || reason === 'insufficientPermissions' || reason === 'authError') {
    return new PostError('auth_required', 'Google sign-in is no longer valid. Reconnect your account.', 401);
  }
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return new PostError('quota_exhausted', 'YouTube API quota exhausted for today', 429);
  }
  if (status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return new PostError('rate_limited', 'YouTube is rate limiting requests. Try again shortly.', 429, true);
  }
  if (reason === 'ineligibleAccount') {
    return new PostError('ineligible_account', 'This Google account has no YouTube channel that can comment', 403);
  }
  if (
    reason === 'operationNotSupported' ||
    reason === 'forbidden' ||
    reason === 'commentsDisabled' ||
    reason === 'parentCommentIsPrivate'
  ) {
    return new PostError('cannot_reply', 'YouTube does not allow replying to this comment', 422);
  }
  if (status === 404 || reason === 'parentCommentNotFound' || reason === 'commentNotFound') {
    return new PostError('comment_gone', 'That comment no longer exists on YouTube', 404);
  }
  if (reason === 'commentTextTooLong') return new PostError('text_too_long', e.message, 400);
  if (reason === 'commentTextRequired' || reason === 'invalidCustomEmoji' || reason === 'processingFailure') {
    return new PostError('bad_text', e.message, 400);
  }
  return new PostError('post_failed', e.message, 502, status >= 500 || e.network);
}

export interface ReplyPosterDeps {
  repo: Repo;
  auth: GoogleAuth;
  quota: QuotaTracker;
  gateway: PostGateway;
  handoff: ReplyPoster;
  clock?: () => Date;
}

/** Switches between posting through the YouTube API (when a Google account is usable) and the hand-off flow. */
export function createReplyPoster(deps: ReplyPosterDeps): ReplyPoster {
  const { repo, auth, quota, gateway, handoff } = deps;
  const clock = deps.clock ?? (() => new Date());
  const inflight = new Map<string, true>();

  const apiMode = () => auth.canPost();

  /** Did our (possibly failed-looking) insert actually land? Throws if the lookup itself fails. */
  async function findPosted(
    token: string,
    channelId: string,
    parentId: string,
    videoId: string,
    text: string,
    startedAt: Date,
  ): Promise<YtComment | null> {
    const wanted = norm(text);
    const since = startedAt.getTime() - VERIFY_SKEW_MS;
    const list = await gateway.listReplies(token, parentId, videoId);
    quota.charge('comments.list', 1);
    return (
      list.find(
        (c) =>
          c.authorChannelId === channelId &&
          new Date(c.publishedAt).getTime() >= since &&
          norm(htmlToPlain(c.textHtml)) === wanted,
      ) ?? null
    );
  }

  async function postViaApi(comment: Parameters<ReplyPoster['reply']>[0], body: string) {
    const text = body.trim();
    if (text === '') throw new PostError('bad_text', 'Reply is empty', 400);
    if (text.length > MAX_TEXT) throw new PostError('text_too_long', `Reply is over ${MAX_TEXT} characters`, 400);
    const parentId = comment.parentId ?? comment.id;
    if (parentId !== comment.threadId) throw new PostError('cannot_reply', 'Unexpected comment parent', 422);
    const thread = repo.getThread(comment.threadId);
    if (!thread) throw new PostError('comment_gone', 'Thread not found', 404);
    if (!thread.canReply) throw new PostError('cannot_reply', 'Replies are disabled on this comment', 422);

    if (inflight.has(comment.id)) {
      throw new PostError('duplicate_in_flight', 'A reply to this comment is already being posted', 409);
    }
    inflight.set(comment.id, true);
    try {
      const hash = sha256(text);
      const since = new Date(clock().getTime() - DEDUPE_WINDOW_MS).toISOString();
      const dup = repo.recentPostedReply(comment.id, hash, since);
      if (dup) {
        const posted = repo.getComment(dup.postedCommentId);
        if (posted) {
          // No second insert. Re-assert the 'replied' state (cheap, and gives the client a valid actionId).
          return { mode: 'posted' as const, comment: posted, actionId: repo.triage([comment.id], 'replied').actionId };
        }
      }
      if (!quota.canManual()) throw new PostError('quota_exhausted', 'Daily API quota exhausted', 429);

      const account = auth.pickAccount(thread.video.channelId);
      if (!account) throw new PostError('auth_required', 'No usable Google account is connected', 401);
      const { token, channelId } = await auth.getAccessToken(account.channelId);

      const postId = repo.beginReplyPost(comment.id, hash);
      const startedAt = clock();
      const fail = (err: PostError, status: 'failed' | 'unknown' = 'failed') => {
        repo.finishReplyPost(postId, { status, viaChannelId: channelId, error: `${err.code}: ${err.message}` });
        return err;
      };

      const attempt = () => gateway.insertReply(token, { parentId, videoId: comment.videoId, text });
      quota.charge('comments.insert', INSERT_UNITS); // a never-sent retry is not billed twice

      let posted: YtComment | null = null;
      try {
        try {
          posted = await attempt();
        } catch (e) {
          // Only a provable "never left this machine" failure may be retried, once.
          if (e instanceof GatewayError && e.network && e.reason && NEVER_SENT.has(e.reason)) posted = await attempt();
          else throw e;
        }
      } catch (e) {
        if (!(e instanceof GatewayError)) throw fail(new PostError('post_failed', String(e), 502, true));
        const neverSent = e.network && !!e.reason && NEVER_SENT.has(e.reason);
        const ambiguous = !neverSent && (e.network || e.status >= 500);
        if (!ambiguous) {
          const err = mapGatewayError(e);
          if (err.code === 'auth_required') {
            repo.updateGoogleAccount(channelId, { needsReauth: true, lastError: e.message, accessToken: null });
          } else if (err.code === 'quota_exhausted') {
            quota.blockUntilNextDay();
          } else if (e.reason === 'operationNotSupported') {
            repo.setThreadCanReply(comment.threadId, false);
          }
          throw fail(err);
        }
        // Ambiguous: the insert may have succeeded. Look before telling the user anything.
        try {
          posted = await findPosted(token, channelId, parentId, comment.videoId, text, startedAt);
        } catch {
          throw fail(
            new PostError('post_unconfirmed', 'Could not confirm whether the reply posted. Check on YouTube.', 502),
            'unknown',
          );
        }
        if (!posted) {
          throw fail(new PostError('post_failed', 'YouTube did not accept the reply. Try again.', 502, true));
        }
      }

      const final: YtComment = { ...posted, authorChannelId: posted.authorChannelId ?? channelId };
      // Safety net: without this the posted reply would arrive as a non-own inbox item and auto-clear would not fire.
      if (final.authorChannelId) setOwnChannelId(repo, final.authorChannelId, true);
      const rec = repo.recordPostedReply({
        commentId: comment.id,
        body: text,
        posted: final,
        viaChannelId: channelId,
        replyPostId: postId,
      });
      return { mode: 'posted' as const, comment: repo.getComment(final.id)!, actionId: rec.actionId };
    } finally {
      inflight.delete(comment.id);
    }
  }

  return {
    capabilities() {
      if (!apiMode()) return handoff.capabilities();
      const acct = auth.pickAccount(null);
      return {
        canPost: true,
        postMode: 'api',
        postAs: acct ? { channelId: acct.channelId, title: acct.title } : null,
      };
    },

    async reply(comment, body) {
      if (!apiMode()) return handoff.reply(comment, body);
      return postViaApi(comment, body);
    },

    async deleteReply(comment) {
      if (!comment.isOwn || !comment.parentId || !repo.isAppPostedReply(comment.id)) {
        throw new PostError('cannot_reply', 'Only replies posted from Nudge can be deleted here', 422);
      }
      if (!quota.canManual()) throw new PostError('quota_exhausted', 'Daily API quota exhausted', 429);
      const { token } = await auth.getAccessToken(comment.authorChannelId ?? undefined);
      quota.charge('comments.delete', DELETE_UNITS);
      try {
        await gateway.deleteComment(token, comment.id);
      } catch (e) {
        if (!(e instanceof GatewayError)) throw e;
        // Already gone on YouTube: just drop the local copy.
        if (e.status !== 404) {
          const err =
            e.network || e.status >= 500 ? new PostError('post_failed', e.message, 502, true) : mapGatewayError(e);
          if (err.code === 'quota_exhausted') quota.blockUntilNextDay();
          throw err;
        }
      }
      repo.removeLocalComment(comment.id);
    },
  };
}
