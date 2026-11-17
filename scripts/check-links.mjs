#!/usr/bin/env node
// Checks that every relative link, and every #anchor, in the project's Markdown resolves: the README, CONTRIBUTING.md,
// SECURITY.md and docs/*.md. The docs are split across files that point into each other's sections, so a renamed
// heading or a moved section would otherwise leave a dead link nobody notices. Anchors are worked out the way GitHub
// does it. External links (https:, mailto:) are not fetched.
//
//   node scripts/check-links.mjs        exit 1 and list each broken link, or say how many were checked
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function filesToCheck() {
  const docs = readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('docs', f));
  return ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', ...docs].map((f) => join(ROOT, f));
}

/** The lines outside fenced code blocks, with inline code spans blanked so a `[x](y)` in backticks is not a link. */
function proseLines(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      out.push('');
      continue;
    }
    out.push(fence === null ? line.replace(/(`+)[^`]*?\1/g, (s) => ' '.repeat(s.length)) : '');
  }
  return out;
}

/** GitHub's heading id: the rendered text, lowercased, punctuation dropped, spaces turned into hyphens. */
function slug(heading) {
  const text = heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images keep their alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links keep their text
    .replace(/<[^>]+>/g, '') // inline HTML
    .replace(/[*~`]/g, ''); // emphasis and code marks
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

const anchorCache = new Map();

/** Every anchor a Markdown file defines: its headings (with GitHub's -1, -2 suffixes for repeats) and HTML ids. */
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const anchors = new Set();
  const seen = new Map();
  const raw = readFileSync(file, 'utf8');
  let fence = null;
  for (const line of raw.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slug(h[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const m of line.matchAll(/<a\s[^>]*(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

/** Link targets on a line: inline links and images, and the src/href of HTML tags. */
function targets(line) {
  const out = [];
  for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  for (const m of line.matchAll(/<(?:a|img)\s[^>]*(?:href|src)="([^"]+)"/g)) out.push(m[1]);
  return out;
}

function check() {
  const problems = [];
  let checked = 0;
  for (const file of filesToCheck()) {
    const rel = relative(ROOT, file);
    proseLines(readFileSync(file, 'utf8')).forEach((line, i) => {
      for (const target of targets(line)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto: and the like
        checked++;
        const where = `${rel}:${i + 1}: ${target}`;
        const [path, anchor] = target.split('#', 2);
        const dest = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
        if (!dest.startsWith(ROOT) || !existsSync(dest)) {
          problems.push(`${where} (no such file)`);
          continue;
        }
        if (anchor === undefined || !dest.endsWith('.md') || statSync(dest).isDirectory()) continue;
        if (!anchorsOf(dest).has(decodeURIComponent(anchor))) problems.push(`${where} (no such heading)`);
      }
    });
  }
  return { problems, checked };
}

const { problems, checked } = check();
if (problems.length) {
  console.error(`Broken links (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-links: ${checked} relative links resolve.`);
