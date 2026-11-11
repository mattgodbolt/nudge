import { describe, expect, it } from 'vitest';
import type { UsageDTO } from '../../../shared/usage';
import { featureLabel, formatMicros, summarise } from './usage-view';

const dto: UsageDTO = {
  days: 3,
  from: '2026-11-09',
  to: '2026-11-11',
  rows: [
    { day: '2026-11-09', key: 'done.kbd', count: 6 },
    { day: '2026-11-09', key: 'done.btn', count: 2 },
    { day: '2026-11-11', key: 'snooze.touch', count: 3 },
    { day: '2026-11-11', key: 'view.stats', count: 1 },
    { day: '2026-11-11', key: 'assistant.call', count: 4 },
    { day: '2026-11-11', key: 'assistant.cost_micros', count: 2500 },
    { day: '2026-11-11', key: 'device.phone', count: 1 },
    { day: '2026-11-11', key: 'session.active_minute', count: 20 },
  ],
  events: [
    { day: '2026-11-11', kind: 'state', source: 'user', count: 5 },
    { day: '2026-11-11', kind: 'state', source: 'auto', count: 2 },
    { day: '2026-11-10', kind: 'snooze', source: 'user', count: 1 },
  ],
  unused: ['mute'],
};

describe('summarise', () => {
  const s = summarise(dto);

  it('ranks features, merging the ways each was invoked, and leaves out bookkeeping', () => {
    expect(s.top).toEqual([
      { feature: 'done', count: 8 },
      { feature: 'snooze', count: 3 },
      { feature: 'view.stats', count: 1 },
    ]);
    expect(s.total).toBe(12);
  });

  it('shares out invocation routes over action keys only', () => {
    expect(s.via).toEqual({ kbd: 6, btn: 2, touch: 3, palette: 0 });
  });

  it('fills days with no use with zero', () => {
    expect(s.perDay).toEqual([
      { day: '2026-11-09', count: 8 },
      { day: '2026-11-10', count: 0 },
      { day: '2026-11-11', count: 4 },
    ]);
  });

  it('collects assistant, session and event-log numbers', () => {
    expect(s.assistant).toMatchObject({ calls: 4, costMicros: 2500 });
    expect(s.sessions).toMatchObject({ phone: 1, activeMinutes: 20 });
    expect(s.events).toEqual([
      { kind: 'state', user: 5, auto: 2, sync: 0, total: 7 },
      { kind: 'snooze', user: 1, auto: 0, sync: 0, total: 1 },
    ]);
    expect(s.unused).toEqual(['mute']);
  });
});

describe('labels', () => {
  it('reads naturally', () => {
    expect(featureLabel('done')).toBe('Done');
    expect(featureLabel('open_source')).toBe('Open source');
    expect(featureLabel('view.github_thread')).toBe('View: github thread');
    expect(formatMicros(2500)).toBe('$0.003');
    expect(formatMicros(12_340_000)).toBe('$12.34');
  });
});
