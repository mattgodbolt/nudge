import { describe, expect, it } from 'vitest';
import type { InboxItem, SnoozeBucket } from '../../../shared/types';
import { snoozedEntries } from './snoozeSections';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const it_ = (id: string, bucket: SnoozeBucket | null, daysAgo: number): InboxItem =>
  ({
    comment: { id },
    snoozeBucket: bucket,
    snoozedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  }) as unknown as InboxItem;

describe('snoozedEntries', () => {
  it('puts a heading wherever the bucket changes, with the count and the age of the oldest', () => {
    const e = snoozedEntries(
      [it_('a', 'waiting_on_them', 2), it_('b', 'waiting_on_them', 9), it_('c', 'in_flight', 1), it_('d', null, 20)],
      NOW,
      false,
    );
    expect(e.map((x) => (x.kind === 'head' ? `${x.title} (${x.count}) ${x.oldest}` : x.item.comment.id))).toEqual([
      'Waiting on them (2) 9d',
      'a',
      'b',
      'In flight (1) 1d',
      'c',
      'No reason given (1) 2w',
      'd',
    ]);
  });

  it('marks the last section as possibly longer while more pages remain, and is empty for an empty list', () => {
    const e = snoozedEntries([it_('a', 'lower_priority', 0)], NOW, true);
    expect(e[0]).toMatchObject({ kind: 'head', title: 'Lower priority / someday', more: true, oldest: 'today' });
    expect(snoozedEntries([], NOW, false)).toEqual([]);
  });
});
