import { describe, expect, it } from 'vitest';
import { buildChanged, entryScript, parsePing } from './build';

const page = (hash: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-${hash}.js"></script></head></html>`;

describe('entryScript', () => {
  it('names the hashed entry script, and nothing for a dev page', () => {
    expect(entryScript(page('CnGpmrSF'))).toBe('/assets/index-CnGpmrSF.js');
    expect(entryScript('<script type="module" src="/src/main.ts"></script>')).toBeNull();
  });
});

describe('buildChanged', () => {
  it('is true only when both builds are known and differ', () => {
    expect(buildChanged('/assets/index-new.js', '/assets/index-old.js')).toBe(true);
    expect(buildChanged('/assets/index-same.js', '/assets/index-same.js')).toBe(false);
    expect(buildChanged(null, '/assets/index-old.js')).toBe(false);
    expect(buildChanged('/assets/index-new.js', null)).toBe(false);
    expect(buildChanged(undefined, undefined)).toBe(false);
    expect(buildChanged('', '/assets/index-old.js')).toBe(false);
  });
});

describe('parsePing', () => {
  it('reads the build, and shrugs at anything else (the old server sent a bare 1)', () => {
    expect(parsePing('{"build":"/assets/index-x.js"}')).toEqual({ build: '/assets/index-x.js' });
    expect(parsePing('{"build":null}')).toEqual({ build: null });
    expect(parsePing('1')).toEqual({ build: null });
    expect(parsePing('not json')).toEqual({ build: null });
    expect(parsePing(undefined)).toEqual({ build: null });
    expect(parsePing(`{"build":"${'x'.repeat(500)}"}`)).toEqual({ build: null });
    expect(parsePing('{"build":7}')).toEqual({ build: null });
  });
});
