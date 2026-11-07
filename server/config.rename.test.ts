import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DB, loadConfig, migrateLegacyDb } from './config.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'nudge-cfg-'));

describe('pre-rename compatibility', () => {
  it('reads YOUTUBEY_* env vars, but NUDGE_* wins', () => {
    expect(loadConfig({ YOUTUBEY_PORT: '5000', YOUTUBEY_DB: 'x.db' }, tmp())).toMatchObject({
      port: 5000,
      dbPath: 'x.db',
    });
    expect(loadConfig({ YOUTUBEY_PORT: '5000', NUDGE_PORT: '6000' }, tmp()).port).toBe(6000);
  });

  it('falls back to ~/.youtubey-* files only when the ~/.nudge-* ones do not exist', () => {
    const home = tmp();
    expect(loadConfig({}, home).keyFile).toBe(join(home, '.nudge-key'));
    writeFileSync(join(home, '.youtubey-key'), 'k');
    expect(loadConfig({}, home).keyFile).toBe(join(home, '.youtubey-key'));
    writeFileSync(join(home, '.nudge-key'), 'k2');
    expect(loadConfig({}, home).keyFile).toBe(join(home, '.nudge-key'));
  });

  it('moves the legacy database with its WAL files, once, and never over an existing one', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'data'));
    const legacy = join(dir, 'data', 'youtubey.db');
    for (const s of ['', '-wal', '-shm']) writeFileSync(legacy + s, 'x');
    const prev = process.cwd();
    process.chdir(dir);
    try {
      expect(migrateLegacyDb(DEFAULT_DB)).toBe(true);
      expect(existsSync(DEFAULT_DB + '-wal')).toBe(true);
      expect(existsSync(legacy)).toBe(false);
      writeFileSync(legacy, 'old');
      expect(migrateLegacyDb(DEFAULT_DB)).toBe(false); // new one exists: leave both alone
      expect(existsSync(legacy)).toBe(true);
      expect(migrateLegacyDb('custom.db')).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });
});

describe('network config', () => {
  it('defaults to loopback with nothing extra allowed', () => {
    expect(loadConfig({}, tmp())).toMatchObject({ host: '127.0.0.1', allowedHosts: [], allowedUsers: [] });
  });
  it('parses comma-separated lists and a custom bind host', () => {
    expect(
      loadConfig(
        { NUDGE_HOST: '0.0.0.0', NUDGE_ALLOWED_HOSTS: 'a.ts.net, b.ts.net ,', NUDGE_ALLOWED_USERS: 'm@x.com' },
        tmp(),
      ),
    ).toMatchObject({ host: '0.0.0.0', allowedHosts: ['a.ts.net', 'b.ts.net'], allowedUsers: ['m@x.com'] });
  });
});
