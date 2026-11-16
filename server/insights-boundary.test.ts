import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Insights must never change how Nudge works (docs/INSIGHTS.md §1). The repository has no ESLint, so, as for Adventure
// mode (rpg-boundary.test.ts), this test is the import restriction: only the files listed here may import the
// Insights layer, which keeps it out of the inbox, keys, snooze, suggestion, sync and push code. It also checks that
// the readers it is built on write nothing.
const ROOT = join(import.meta.dirname, '..');
const ALLOWED = new Set([
  'server/insights-boundary.test.ts',
  'server/app.ts',
  'server/index.ts',
  'server/contracts.ts',
  'server/db/insights.ts',
  'server/db/insights.test.ts',
  'server/routes/insights.ts',
  'server/routes/insights.test.ts',
  'server/demo/history.test.ts',
  'shared/insights.ts',
  'shared/insights.test.ts',
  'web/src/lib/api.ts',
  'web/src/lib/insights.ts',
  'web/src/lib/insights.test.ts',
  'web/src/views/StatsView.svelte',
  'web/src/components/InsightsPanel.svelte',
  'web/src/components/InsightsPanel.test.ts',
]);
const INSIGHTS_IMPORT = /\bfrom\s+['"][^'"]*\/(insights(\.js|\.ts)?|InsightsPanel\.svelte|insights\/\w+\.svelte)['"]/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|svelte)$/.test(name)) out.push(p);
  }
  return out;
}

describe('the Insights boundary', () => {
  const all = ['server', 'shared', 'web/src'].flatMap((d) => files(join(ROOT, d)));

  it('is imported only by its own files and the few places that show it', () => {
    const offenders = all
      .map((p) => relative(ROOT, p))
      .filter((rel) => !rel.startsWith('web/src/components/insights/'))
      .filter((rel) => !ALLOWED.has(rel) && INSIGHTS_IMPORT.test(readFileSync(join(ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('catches an import if one is added (the pattern itself works)', () => {
    expect(INSIGHTS_IMPORT.test("import { insightsReport } from './db/insights.js';")).toBe(true);
    expect(INSIGHTS_IMPORT.test("import type { Insights } from '../../../shared/insights';")).toBe(true);
    expect(INSIGHTS_IMPORT.test("import Heatmap from './insights/Heatmap.svelte';")).toBe(true);
    expect(INSIGHTS_IMPORT.test("import InsightsPanel from '../components/InsightsPanel.svelte';")).toBe(true);
    expect(INSIGHTS_IMPORT.test("import { repo } from './db/repo.js';")).toBe(false);
  });

  it('keeps the readers free of writes: insights, the shared history helpers and the replay', () => {
    for (const f of ['server/db/insights.ts', 'server/db/history.ts', 'server/db/replay.ts']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, f).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA)\b/);
      expect(src, f).not.toMatch(/\.(run|exec)\(/);
    }
    // The route reads through the reader only: it touches no repository at all.
    const route = readFileSync(join(ROOT, 'server/routes/insights.ts'), 'utf8');
    expect(route).not.toMatch(/\brepo\b/);
    expect(route).not.toMatch(/app\.(post|put|patch|delete)\(/);
  });

  it('offers nothing to act on: the panel only links to an item, it never calls a write', () => {
    const web = all
      .map((p) => relative(ROOT, p))
      .filter(
        (rel) => rel.startsWith('web/src/components/insights/') || rel === 'web/src/components/InsightsPanel.svelte',
      );
    for (const f of web) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, f).not.toMatch(/api\.(?!insights\b)\w+\(/);
      expect(src, f).not.toMatch(/\b(triage|snooze|undo)\(/);
    }
  });
});
