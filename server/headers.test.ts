import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './headers.js';

const directive = (name: string): string[] =>
  CONTENT_SECURITY_POLICY.split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1) ?? [];

/** Inline <script> bodies (no src) in an HTML page, exactly as the browser hashes them. */
const inlineScripts = (html: string): string[] =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

describe('Content-Security-Policy', () => {
  it('allows every inline script in web/index.html by hash, so editing one without updating the policy fails here', () => {
    const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const body of scripts) {
      const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
      expect(directive('script-src'), 'update THEME_SCRIPT_HASH in server/headers.ts').toContain(hash);
    }
  });

  it('allows nothing inline or remote beyond what the app needs', () => {
    expect(directive('default-src')).toEqual(["'self'"]);
    expect(directive('script-src').filter((s) => !s.startsWith("'sha256-"))).toEqual(["'self'"]);
    expect(directive('connect-src')).toEqual(["'self'"]);
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'none'"]);
    expect(directive('form-action')).toEqual(["'self'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
  });
});
