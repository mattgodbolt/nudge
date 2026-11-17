import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { createRepo } from '../db/repo.js';
import { evalApiKey, evalOwner } from './evalOwner.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const args = (a: Record<string, string>) => ({ arg: (n: string) => a[n] });

/** A database copy as the eval would be given one, with or without a profile. */
function dbWith(owner?: { name: string; about: string }, anthropicKey?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-eval-owner-'));
  dirs.push(dir);
  const path = join(dir, 'nudge.db');
  const repo = createRepo(openDb(path));
  if (owner) repo.updateSettings({ owner });
  if (anthropicKey) repo.updateSettings({ llm: { apiKey: anthropicKey, model: 'claude-haiku-5-5' } });
  repo.close();
  return path;
}

describe('the offline eval needs the owner profile', () => {
  it('reads it from the database copy it is given', () => {
    const db = dbWith({ name: 'Priya', about: 'Maintains a parser.' });
    expect(evalOwner(args({ db }))).toEqual({ name: 'Priya', about: 'Maintains a parser.' });
    // A flag overrides one part.
    expect(evalOwner(args({ db, 'owner-name': 'P' }))).toEqual({ name: 'P', about: 'Maintains a parser.' });
  });
  it('or from flags alone', () => {
    expect(evalOwner(args({ 'owner-name': 'Jun', 'owner-about': 'Keeps a database library alive.' }))).toEqual({
      name: 'Jun',
      about: 'Keeps a database library alive.',
    });
  });
  it('fails with a clear message when there is none', () => {
    const msg = /No owner profile.*--db.*--owner-name/;
    expect(() => evalOwner(args({}))).toThrow(msg);
    expect(() => evalOwner(args({ db: dbWith() }))).toThrow(msg);
    expect(() => evalOwner(args({ 'owner-name': 'Jun' }))).toThrow(msg);
  });
});

describe('the offline eval needs an Anthropic key', () => {
  it('takes ANTHROPIC_API_KEY first', () => {
    const db = dbWith(undefined, 'sk-from-db');
    expect(evalApiKey({ ANTHROPIC_API_KEY: ' sk-from-env ' }, args({ db }))).toBe('sk-from-env');
  });
  it("else the key stored in the --db copy's Settings, read without changing the copy", () => {
    const db = dbWith(undefined, 'sk-from-db');
    expect(evalApiKey({}, args({ db }))).toBe('sk-from-db');
    expect(evalApiKey({ ANTHROPIC_API_KEY: '' }, args({ db }))).toBe('sk-from-db');
  });
  it('fails with a message naming both places when there is neither', () => {
    const msg = /ANTHROPIC_API_KEY.*--db/;
    expect(() => evalApiKey({}, args({}))).toThrow(msg);
    expect(() => evalApiKey({}, args({ db: dbWith() }))).toThrow(msg);
  });
});
