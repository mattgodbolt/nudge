import type { InboxItem } from '../../../shared/types';
import { api } from './api';
import { inbox } from './stores/inbox.svelte';
import { drafts } from './stores/drafts.svelte';
import { settings } from './stores/settings.svelte';
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

/**
 * Must be called synchronously from a key/click handler: in hand-off mode the clipboard write and
 * window.open need the user gesture, so they happen before any await.
 */
export function send(item: InboxItem, body: string): void {
  const id = item.comment.id;
  const text = body.trim();
  if (!text) return;

  if (settings.capabilities.postMode === 'handoff') {
    const url = item.comment.permalink;
    const copied = copy(text);
    const win = window.open(url, '_blank');
    if (win) win.opener = null;
    drafts.hold(id);
    void inbox
      .applyOptimistic(
        [id],
        'replied',
        async () => {
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
    return;
  }

  drafts.hold(id);
  void inbox
    .applyOptimistic(
      [id],
      'replied',
      async () => {
        const r = await api.reply(id, text);
        return { actionId: r.actionId };
      },
      { message: 'Reply posted · z to undo' },
    )
    .then((ok) => {
      // Only forget the draft once the server has confirmed; otherwise the text would be lost.
      if (ok) drafts.discard(id);
      else drafts.restore(id, body);
    });
}
