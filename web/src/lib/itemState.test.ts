import { describe, expect, it } from 'vitest';
import type { InboxItem, SuggestionDTO } from '../../../shared/types';
import { stateLabel, suggestedButton } from './itemState';

const item = (
  s: Partial<SuggestionDTO> | null,
  o: { provider?: 'youtube' | 'github'; state?: string; snoozed?: boolean } = {},
): InboxItem =>
  ({
    item: { provider: o.provider ?? 'github' },
    comment: { state: o.state ?? 'inbox' },
    snoozedUntil: o.snoozed ? '2030-01-01T00:00:00Z' : null,
    suggestion: s ? { action: 'act', reason: '', confidence: 'high', suspicious: false, ...s } : null,
  }) as unknown as InboxItem;

describe('stateLabel', () => {
  it('tells a dismissal from a plain done', () => {
    expect(stateLabel({ state: 'done' })).toBe('Done');
    expect(stateLabel({ state: 'done', doneReason: 'no_action' })).toBe('Dismissed');
    expect(stateLabel({ state: 'replied' })).toBe('Replied');
    expect(stateLabel({ state: 'resolved' })).toBe('Closed');
    expect(stateLabel({ state: 'inbox' })).toBe('');
  });
});

describe('suggestedButton', () => {
  it('maps the verdict to the button that carries it out', () => {
    expect(suggestedButton(item({ action: 'act' }), 'thread')).toBe('triage.done');
    expect(suggestedButton(item({ action: 'skip' }), 'thread')).toBe('triage.dismiss');
    expect(suggestedButton(item({ action: 'spam' }), 'row')).toBe('triage.dismiss');
    expect(suggestedButton(item({ action: 'reply' }), 'thread')).toBe('triage.replied');
  });
  it('points a YouTube thread at Reply, but a row at Mark replied (rows have no Reply)', () => {
    expect(suggestedButton(item({ action: 'reply' }, { provider: 'youtube' }), 'thread')).toBe('reply.open');
    expect(suggestedButton(item({ action: 'reply' }, { provider: 'youtube' }), 'row')).toBe('triage.replied');
  });
  it('points at Snooze when the model says it is waiting on them', () => {
    expect(suggestedButton(item({ action: 'reply', turn: 'them' }), 'thread')).toBe('snooze.open');
    expect(suggestedButton(item({ action: 'skip', turn: 'them' }), 'row')).toBe('snooze.open');
    expect(suggestedButton(item({ action: 'act', turn: 'me' }), 'row')).toBe('triage.done');
  });
  it('says nothing without a usable suggestion, or once the item is dealt with or asleep', () => {
    expect(suggestedButton(item(null), 'row')).toBeNull();
    expect(suggestedButton(item({ action: null, suspicious: true }), 'row')).toBeNull();
    expect(suggestedButton(item({ action: 'act' }, { state: 'done' }), 'row')).toBeNull();
    expect(suggestedButton(item({ action: 'act' }, { snoozed: true }), 'row')).toBeNull();
  });
});
