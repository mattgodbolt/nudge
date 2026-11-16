import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Insights, InsightsRange } from '../../../shared/insights';
import { emptyInsights } from '../../../server/db/insights';

const calls: { range: InsightsRange; tz: string }[] = [];
let next: (range: InsightsRange) => Insights;
vi.mock('../lib/api', () => ({
  api: {
    insights: (range: InsightsRange, tz: string) => {
      calls.push({ range, tz });
      return Promise.resolve(next(range));
    },
  },
}));
const { default: InsightsPanel } = await import('./InsightsPanel.svelte');

const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const NOW = new Date('2026-11-16T12:00:00.000Z');
const base = (range: InsightsRange = '30d'): Insights => ({
  ...emptyInsights({ range, tz: 'UTC', now: NOW }),
  empty: false,
  from: '2026-10-18',
  days: 30,
});

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
});
afterEach(() => cleanup());

describe('InsightsPanel', () => {
  it('an empty history: one friendly line and no cards', async () => {
    next = (r) => emptyInsights({ range: r, tz: 'UTC', now: NOW });
    render(InsightsPanel);
    expect(text(await screen.findByTestId('insights-empty'))).toContain(
      'Insights appear once things arrive and you deal with them.',
    );
    expect(screen.queryByTestId('insight-arrivals')).toBeNull();
  });

  it('a thin history: whole groups collapse to one line, each saying how far off it is', async () => {
    next = (r) => {
      const i = base(r);
      i.rhythm.arrivals = { n: 12, min: 50, data: null };
      i.rhythm.actions = { n: 3, min: 50, data: null };
      return i;
    };
    render(InsightsPanel);
    expect(text(await screen.findByTestId('group-empty-rhythm'))).toContain(
      'Rhythm: not enough data yet (12 of 50 arrivals, 3 of 50 actions).',
    );
    expect(screen.getByTestId('group-empty-predictions')).toBeTruthy();
    expect(text(screen.getByTestId('insights-sentence'))).toContain('A quiet month. Lovely.');
  });

  it('a card under its minimum keeps its title and says so while its neighbours draw', async () => {
    next = (r) => {
      const i = base(r);
      i.responses.undos = { n: 5, min: 1, data: { undos: 2, actions: 5 } };
      i.responses.outcomes = { n: 4, min: 20, data: null };
      return i;
    };
    render(InsightsPanel);
    const outcomes = await screen.findByTestId('insight-outcomes');
    expect(text(outcomes)).toContain('What happens to things');
    expect(text(outcomes)).toContain('Not enough data yet (4 of 20)');
    expect(text(screen.getByTestId('insight-undos'))).toContain("Ctrl+Z: used 2 times. Nobody's perfect.");
  });

  it('asks in the browser zone, defaults to 30d, and remembers a new range', async () => {
    next = base;
    render(InsightsPanel);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.range).toBe('30d');
    expect(calls[0]!.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    await fireEvent.click(screen.getByTestId('insights-range-7d'));
    await waitFor(() => expect(calls.at(-1)!.range).toBe('7d'));
    expect(screen.getByTestId('insights-range-7d').getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('nudge.insights.range')).toBe('7d');
  });
});
