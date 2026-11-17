import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Nobody in particular owns Nudge: who the model works for is configuration (Settings > About you), and the prompts are
// built from it. This keeps the owner's identity from creeping back into the source, prompts, demo data and docs.
// Tests are out of scope (they may use any sample name); so are the files that name the author or the repository on
// purpose, below. Repository links (github.com/<owner>/nudge) are allowed anywhere: they say where the code lives.
const ROOT = join(import.meta.dirname, '..');

const ALLOWED = new Set([
  'package.json', // author and repository URLs
  'package-lock.json',
  'LICENSE',
  '.github/CODEOWNERS',
  'docs/PLAN.md', // the original plan, kept as history
  // Migration 018 renames the old stored value, so it has to name it; migrations are never edited afterwards.
  'server/db/migrations.ts',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'screenshots', 'playwright-report']);
const SKIP_DIR_PREFIXES = ['dist', 'test-results'];
const TEXT = /\.(ts|js|mjs|cjs|svelte|html|css|md|json|ya?ml|sh|toml|txt|example)$|^(Dockerfile|LICENSE|CODEOWNERS)$/;

/** The owner's name in any of the shapes it used to appear in: prose, a turn value, a camelCase or snake_case key. */
const IDENTITY = /godbolt|compiler[\s-]explorer|\bmatt\b|ismatt|_matt\b|\bmatt_/i;
const REPO_LINK = /github\.com\/[\w-]+\/nudge\b/gi;

const isTest = (path: string): boolean =>
  /\.test\.ts$/.test(path) || path.startsWith('e2e/') || /(^|\/)test-helpers\.ts$/.test(path);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name) || SKIP_DIR_PREFIXES.some((p) => name.startsWith(p))) continue;
      yield* files(full);
    } else if (TEXT.test(name) || name.startsWith('.env')) {
      yield relative(ROOT, full).split('\\').join('/');
    }
  }
}

/** Every line naming the owner, as `path:line: text`. */
function leaks(): string[] {
  const out: string[] = [];
  for (const path of files(ROOT)) {
    if (ALLOWED.has(path) || isTest(path)) continue;
    readFileSync(join(ROOT, path), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (IDENTITY.test(line.replace(REPO_LINK, ''))) out.push(`${path}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
  }
  return out;
}

describe("the owner's identity is configuration, not code", () => {
  it('appears nowhere in the source, prompts, demo data or docs outside the allowlist', () => {
    expect(leaks()).toEqual([]);
  });

  it('would be caught in each of the shapes it used to take', () => {
    for (const s of [
      'Matt reads it first',
      'is_matt="true"',
      'isMatt: true',
      "turn: 'matt'",
      '<matt_note>',
      'Godbolt',
    ]) {
      expect(IDENTITY.test(s), s).toBe(true);
    }
    // Ordinary words are not names, and a link to the repository is not a leak.
    for (const s of ['what matters most', 'formatted', 'mattress', 'https://github.com/someone/nudge/issues/1']) {
      expect(IDENTITY.test(s.replace(REPO_LINK, '')), s).toBe(false);
    }
  });

  it('looks at the files it is meant to', () => {
    const all = [...files(ROOT)];
    for (const f of ['server/classify/anthropic.ts', 'server/classify/snooze.ts', 'web/src/views/SettingsView.svelte'])
      expect(all).toContain(f);
    expect(all).toContain('README.md');
    expect(all.some((f) => f.startsWith('node_modules/') || f.startsWith('dist/'))).toBe(false);
  });
});
