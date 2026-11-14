import { describe, expect, it } from 'vitest';
import { describeOutcome, localNow } from './assistant';

describe('localNow', () => {
  it('is an ISO local time with the UTC offset, parseable back to the same instant', () => {
    const d = new Date('2026-11-08T19:05:09Z');
    const s = localNow(d);
    expect(s).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(new Date(s).getTime()).toBe(d.getTime());
  });
});

describe('describeOutcome', () => {
  it('says what happened in one line', () => {
    expect(describeOutcome({ type: 'add_todo', id: 'todo:1', title: 'Ring the plumber', due: null })).toBe(
      'Todo: Ring the plumber',
    );
    expect(describeOutcome({ type: 'add_todo', id: 'todo:1', title: 'X', due: '2030-01-02T09:00:00Z' })).toMatch(
      /^Todo: X \(.+\)$/,
    );
    expect(
      describeOutcome({ type: 'snooze', id: 'a', until: '2030-01-02T09:00:00Z', why: null, undoActionId: 1 }),
    ).toMatch(/^Snoozed until /);
    expect(
      describeOutcome({
        type: 'snooze',
        id: 'a',
        until: '2030-01-02T09:00:00Z',
        why: 'review the fix',
        undoActionId: 1,
      }),
    ).toMatch(/: review the fix$/);
    expect(describeOutcome({ type: 'note', id: 3, scope: 'standing', text: 'Bob matters', itemId: null })).toBe(
      'Noted as a standing preference: Bob matters',
    );
    expect(describeOutcome({ type: 'done', id: 'a', undoActionId: 1 })).toBe('Marked done');
  });
});
