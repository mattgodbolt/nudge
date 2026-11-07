import type { CommentDTO, InboxItem } from '../../../shared/types';
import { api, ApiRequestError } from './api';
import { router } from './router.svelte';
import { inbox } from './stores/inbox.svelte';
import { drafts } from './stores/drafts.svelte';
import { settings } from './stores/settings.svelte';
import { thread } from './stores/thread.svelte';
import { toasts } from './stores/toasts.svelte';

function copy(body: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(body).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

export function copyOnly(body: string) {
  void copy(body).then((ok) =>
    toasts.push({ message: ok ? 'Copied to clipboard' : 'Could not copy', kind: ok ? 'info' : 'error' }),
  );
}

/** Posts that are currently being sent, keyed by comment id: a second press (key or button) is ignored. */
const inflight = new Set<string>();

/**
 * Copy the text and open the comment on YouTube. Must be called synchronously from a key/click handler: the
 * clipboard write and window.open need the user gesture, so they happen before any await.
 * In API mode the server must not post, so the comment is only marked replied.
 */
export function handoff(item: InboxItem, body: string): void {
  const id = item.comment.id;
  const text = body.trim();
  if (!text) return;
  const url = item.comment.permalink;
  const copied = copy(text);
  const win = window.open(url, '_blank');
  if (win) win.opener = null;
  drafts.hold(id);
  const viaApi = settings.capabilities.postMode === 'api';
  void inbox
    .applyOptimistic(
      [id],
      'replied',
      async () => {
        if (viaApi) return api.triage([id], 'replied');
        const r = await api.reply(id, text);
        return { actionId: r.actionId };
      },
      { message: null },
    )
    .then(async (ok) => {
      if (!ok) {
        drafts.restore(id, body);
        return;
      }
      drafts.discard(id);
      const didCopy = await copied;
      toasts.push({
        message: `${didCopy ? 'Copied' : 'Copy failed'}${win ? ' and opened on YouTube' : ''} · marked replied · z to undo`,
        kind: didCopy ? 'success' : 'error',
        action: win
          ? { label: 'Undo', run: () => void inbox.undo() }
          : { label: 'Open', run: () => window.open(url, '_blank') },
      });
    });
}

/** Toast for a failed API post; actions that copy/open run inside the toast click, which is a user gesture. */
function postFailure(item: InboxItem, body: string, e: unknown) {
  const code = e instanceof ApiRequestError ? e.code : 'unknown';
  const message = e instanceof Error ? e.message : 'Could not post the reply';
  const url = item.comment.permalink;
  const copyOpen = { label: 'Copy & open', run: () => handoff(item, body) };
  const fail = (m: string, action?: { label: string; run: () => void }) =>
    toasts.push({ message: m, kind: 'error', action, timeoutMs: 12000 });
  switch (code) {
    case 'auth_required':
      fail('Google sign-in expired · reconnect to post replies', {
        label: 'Reconnect',
        run: () => router.navigate('settings'),
      });
      toasts.push({ message: 'Or post it by hand instead', action: copyOpen, timeoutMs: 12000 });
      break;
    case 'quota_exhausted':
    case 'cannot_reply':
      fail(message, copyOpen);
      break;
    case 'rate_limited':
    case 'post_failed':
      fail(message, { label: 'Retry', run: () => send(item, body) });
      break;
    case 'post_unconfirmed':
      fail(`${message} · check YouTube before retrying`, {
        label: 'Open on YouTube',
        run: () => window.open(url, '_blank', 'noopener'),
      });
      break;
    case 'comment_gone':
      fail('That comment no longer exists on YouTube', {
        label: 'Done',
        run: () => void inbox.triage('done', [item.comment.id]),
      });
      break;
    case 'ineligible_account':
      fail(message, { label: 'Settings', run: () => router.navigate('settings') });
      break;
    default:
      // text_too_long / bad_text: the draft is back in the composer for editing.
      fail(`Could not post: ${message}`);
  }
}

function post(item: InboxItem, body: string, text: string): void {
  const id = item.comment.id;
  if (inflight.has(id)) return;
  inflight.add(id);
  const sticky = toasts.push({ message: 'Posting reply…', timeoutMs: 0 });
  let failure: unknown = null;
  const result: { permalink?: string; handoffUrl?: string } = {};
  drafts.hold(id);
  void inbox
    .applyOptimistic(
      [id],
      'replied',
      async () => {
        const r = await api.reply(id, text);
        if (r.mode === 'posted') result.permalink = r.comment.permalink;
        else result.handoffUrl = r.url;
        return { actionId: r.actionId };
      },
      {
        message: null,
        onError: (e) => {
          failure = e;
        },
      },
    )
    .then((ok) => {
      toasts.dismiss(sticky);
      inflight.delete(id);
      if (ok) {
        // Only forget the draft once the server has confirmed; otherwise the text would be lost.
        drafts.discard(id);
        const handoffUrl = result.handoffUrl;
        if (handoffUrl) {
          // The server could not post (e.g. sign-in lapsed since the page loaded) and only recorded a hand-off.
          // Nothing was sent to YouTube, so be honest and let the click (a user gesture) copy and open.
          toasts.push({
            message: 'Not posted: Google account not connected. Marked replied; copy it and reply on YouTube.',
            kind: 'error',
            action: {
              label: 'Copy & open',
              run: () => {
                void navigator.clipboard?.writeText(body).catch(() => {});
                window.open(handoffUrl, '_blank', 'noopener');
              },
            },
            timeoutMs: 0,
          });
          return;
        }
        const as = settings.capabilities.postAs?.title;
        const permalink = result.permalink;
        toasts.push({
          message: `Reply posted${as ? ` as ${as}` : ''} · z moves it back to inbox`,
          kind: 'success',
          action: permalink ? { label: 'Open', run: () => window.open(permalink, '_blank', 'noopener') } : undefined,
          timeoutMs: 8000,
        });
        return;
      }
      const unconfirmed = failure instanceof ApiRequestError && failure.code === 'post_unconfirmed';
      // An unconfirmed post may well be live: don't offer the text as unsent, or a re-send would duplicate it.
      if (unconfirmed) drafts.discard(id);
      else drafts.restore(id, body);
      postFailure(item, body, failure ?? new Error('Could not post the reply'));
    });
}

export function send(item: InboxItem, body: string): void {
  const text = body.trim();
  if (!text) return;
  if (settings.capabilities.postMode === 'handoff') handoff(item, body);
  else post(item, body, text);
}

/** Remove an own reply that this app posted (costs 50 quota units). The caller has already confirmed. */
export async function deleteReply(comment: Pick<CommentDTO, 'id' | 'threadId'>): Promise<boolean> {
  try {
    await api.deleteReply(comment.id);
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : 'Could not delete the reply');
    return false;
  }
  toasts.push({ message: 'Reply deleted from YouTube', kind: 'success', timeoutMs: 4000 });
  thread.invalidate();
  void thread.show(comment.threadId);
  void inbox.refreshTop();
  return true;
}
