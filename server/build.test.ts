import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuildId } from './build.js';

const page = (hash: string) => `<html><script type="module" src="/assets/index-${hash}.js"></script></html>`;
const dirs: string[] = [];
const site = (html: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-build-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), html);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('createBuildId', () => {
  it('names the entry script of the index.html on disk, and follows it when it is replaced', () => {
    const dir = site(page('one'));
    const id = createBuildId(dir);
    expect(id()).toBe('/assets/index-one.js');
    writeFileSync(join(dir, 'index.html'), page('two'));
    utimesSync(join(dir, 'index.html'), new Date(), new Date(Date.now() + 5000));
    expect(id()).toBe('/assets/index-two.js');
  });
  it('is null with no built UI or an index.html that names no hashed script', () => {
    expect(createBuildId(undefined)()).toBeNull();
    expect(createBuildId(join(tmpdir(), 'nudge-no-such-dir'))()).toBeNull();
    expect(createBuildId(site('<html><script src="/src/main.ts"></script></html>'))()).toBeNull();
  });
  it('lets an override stand in for a build that does not exist', () => {
    expect(createBuildId(site(page('one')), '/assets/index-fake.js')()).toBe('/assets/index-fake.js');
  });
});
