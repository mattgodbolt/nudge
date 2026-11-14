import { BUCKETS, ageText, type SnoozeBucket } from '../../../shared/snooze';
import type { InboxItem } from '../../../shared/types';

/** What the Snoozed list shows: a heading for each reason bucket, then its items. */
export type SnoozedEntry =
  | {
      kind: 'head';
      id: string;
      bucket: SnoozeBucket | null;
      title: string;
      count: number;
      more: boolean;
      oldest: string;
    }
  | { kind: 'row'; item: InboxItem };

export const NO_BUCKET_HEADING = 'No reason given';

/**
 * Sections for the Snoozed view. The list arrives already ordered by bucket (the server's and the store's sort agree),
 * so a heading is wherever the bucket changes. Counts are of what is loaded: `more` marks the last section when the
 * server has further pages, whose items may still belong to it.
 */
export function snoozedEntries(items: InboxItem[], now: number, hasMore: boolean): SnoozedEntry[] {
  const out: SnoozedEntry[] = [];
  let head: Extract<SnoozedEntry, { kind: 'head' }> | null = null;
  let oldest: string | null = null;
  const close = () => {
    if (head) head.oldest = oldest ? ageText(oldest, now) : '';
  };
  for (const item of items) {
    const bucket = item.snoozeBucket;
    if (!head || head.bucket !== bucket) {
      close();
      head = {
        kind: 'head',
        id: `head:${bucket ?? 'none'}`,
        bucket,
        title: bucket ? BUCKETS[bucket].heading : NO_BUCKET_HEADING,
        count: 0,
        more: false,
        oldest: '',
      };
      oldest = null;
      out.push(head);
    }
    head.count++;
    if (item.snoozedAt && (!oldest || item.snoozedAt < oldest)) oldest = item.snoozedAt;
    out.push({ kind: 'row', item });
  }
  close();
  if (head && hasMore) head.more = true;
  return out;
}
