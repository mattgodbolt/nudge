import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Adventure mode must never change how Nudge works (docs/RPG.md). The repository has no ESLint, so this test is the
// import restriction: only the files listed here may import anything of the RPG layer, which keeps it out of the inbox,
// keys, snooze, suggestion, sync and push code. It also checks that the RPG reader writes nothing.
const ROOT = join(import.meta.dirname, '..');
const ALLOWED = new Set([
  'server/rpg-boundary.test.ts', // the patterns below
  'server/app.ts',
  'server/index.ts',
  'server/db/rpg.ts',
  'server/db/rpg.test.ts',
  'server/routes/rpg.ts',
  'server/routes/rpg.test.ts',
  'web/src/App.svelte',
  'web/src/components/Sidebar.svelte',
  'web/src/components/CommandPalette.svelte',
  'web/src/components/RpgArt.svelte',
  'web/src/components/RpgChip.svelte',
  'web/src/components/RpgLayer.svelte',
  'web/src/components/HallOfHeroes.svelte',
  'web/src/views/StatsView.svelte',
  'web/src/lib/rpg.ts',
  'web/src/lib/rpg.test.ts',
  'web/src/lib/levelSound.ts',
  'web/src/lib/levelSound.test.ts',
  'web/src/lib/stores/rpg.svelte.ts',
]);
/** An import of the RPG layer: shared/rpg, server/db/rpg, routes/rpg, the web store and helpers, the components. */
const RPG_IMPORT =
  /\bfrom\s+['"][^'"]*\/(rpg(\.svelte)?|levelSound|Rpg\w+\.svelte|HallOfHeroes\.svelte)(\.js|\.ts)?['"]/;

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

describe('the Adventure mode boundary', () => {
  const all = ['server', 'shared', 'web/src'].flatMap((d) => files(join(ROOT, d)));

  it('is imported only by its own files and the few places that show it', () => {
    const offenders = all
      .map((p) => relative(ROOT, p))
      .filter((rel) => !ALLOWED.has(rel) && RPG_IMPORT.test(readFileSync(join(ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('catches an import if one is added (the pattern itself works)', () => {
    expect(RPG_IMPORT.test("import { rpg } from '../lib/stores/rpg.svelte';")).toBe(true);
    expect(RPG_IMPORT.test("import { rpgSheet } from './db/rpg.js';")).toBe(true);
    expect(RPG_IMPORT.test("import RpgChip from './RpgChip.svelte';")).toBe(true);
    expect(RPG_IMPORT.test("import { levelForXp } from '../../shared/rpg';")).toBe(true);
    expect(RPG_IMPORT.test("import { repo } from './db/repo.js';")).toBe(false);
  });

  it('leaves the decision surfaces alone: no XP anywhere an item is acted on', () => {
    for (const f of [
      'web/src/components/InboxRow.svelte',
      'web/src/components/ThreadView.svelte',
      'web/src/components/ItemActions.svelte',
      'web/src/components/SnoozeMenu.svelte',
      'web/src/views/InboxView.svelte',
    ]) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/\bXP\b|rpg/i);
    }
  });

  it('keeps the RPG reader free of writes', () => {
    const src = readFileSync(join(ROOT, 'server/db/rpg.ts'), 'utf8');
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA)\b/);
    expect(src).not.toMatch(/\.(run|exec)\(/);
    // The routes only ever write the mode's own settings row.
    const routes = readFileSync(join(ROOT, 'server/routes/rpg.ts'), 'utf8');
    expect(routes.match(/repo\.\w+/g)?.filter((c) => c !== 'repo.getSettings' && c !== 'repo.updateSettings')).toEqual(
      [],
    );
    expect(routes).toMatch(/repo\.updateSettings\(\{ rpg: /);
  });
});
