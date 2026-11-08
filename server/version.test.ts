import { describe, expect, it } from 'vitest';
import { resolveVersion } from './version.js';

describe('resolveVersion', () => {
  it('prefers GIT_SHA (Docker images have no .git) and shortens it', () => {
    expect(resolveVersion({ GIT_SHA: '7b49d84abcdef0123456789' })).toBe('7b49d84a');
  });

  it('falls back to git, then to "dev", without throwing', () => {
    expect(resolveVersion({})).toMatch(/^([0-9a-f]{7,8}|dev)$/);
  });
});
