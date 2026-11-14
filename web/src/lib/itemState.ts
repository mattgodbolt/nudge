import type { CommentDTO, InboxItem } from '../../../shared/types';

/** What a finished item says it is: "Dismissed" is a done item the owner marked "no action needed". */
export function stateLabel(c: Pick<CommentDTO, 'state' | 'doneReason'>): string {
  switch (c.state) {
    case 'done':
      return c.doneReason === 'no_action' ? 'Dismissed' : 'Done';
    case 'replied':
      return 'Replied';
    case 'auto_replied':
      return 'Answered';
    case 'resolved':
      return 'Closed';
    default:
      return '';
  }
}

export type DecisionButton = 'triage.done' | 'triage.dismiss' | 'triage.replied' | 'reply.open' | 'snooze.open';

/**
 * The button the current suggestion points at, so it can be quietly emphasised. Advisory only: nothing is ever acted
 * on. "Waiting on them" wins over the verdict (it is what the chip leads with) and points at Snooze. On a YouTube
 * thread, replying is the Reply button; everywhere else it is "Mark replied" (the reply happens off-site).
 */
export function suggestedButton(item: InboxItem, surface: 'row' | 'thread'): DecisionButton | null {
  const s = item.suggestion;
  if (!s || s.suspicious || !s.action) return null;
  if (item.comment.state !== 'inbox' || item.snoozedUntil) return null;
  if (s.turn === 'them') return 'snooze.open';
  switch (s.action) {
    case 'act':
      return 'triage.done';
    case 'skip':
    case 'spam':
      return 'triage.dismiss';
    case 'reply':
      return surface === 'thread' && item.item.provider === 'youtube' ? 'reply.open' : 'triage.replied';
  }
}
