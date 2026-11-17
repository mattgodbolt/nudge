import { describe, expect, it } from 'vitest';
import { DEFAULT_DB, loadConfig, memoryDbRefusal, resolveApiKey } from './config.js';
import { openDb } from './db/db.js';
import { createRepo } from './db/repo.js';

describe('configuration comes from the environment and Settings only', () => {
  it('ignores the pre-rename YOUTUBEY_* variables', () => {
    expect(loadConfig({ YOUTUBEY_PORT: '5000', YOUTUBEY_DB: 'x.db', YOUTUBEY_DEMO: '1' })).toMatchObject({
      port: 4517,
      dbPath: DEFAULT_DB,
      demo: false,
    });
  });

  it('has no key or client file to read', () => {
    const c = loadConfig({});
    expect(c).not.toHaveProperty('keyFile');
    expect(c).not.toHaveProperty('googleClientFile');
  });

  it('resolves the YouTube key from the environment, then Settings, and nowhere else', () => {
    const repo = createRepo(openDb(':memory:'));
    const none = loadConfig({});
    expect(resolveApiKey(none, repo)).toEqual({ key: null, source: null });
    repo.updateSettings({ apiKey: ' from-settings ' });
    expect(resolveApiKey(none, repo)).toEqual({ key: 'from-settings', source: 'settings' });
    expect(resolveApiKey(loadConfig({ YOUTUBE_API_KEY: 'from-env' }), repo)).toEqual({
      key: 'from-env',
      source: 'env',
    });
    repo.close();
  });
});

describe('an in-memory database', () => {
  const MSG = 'NUDGE_DB=:memory: would lose all data when the process exits; it is only allowed in demo mode';

  it('is refused outside demo mode, so a typo cannot run a real instance on data that vanishes', () => {
    expect(memoryDbRefusal(loadConfig({ NUDGE_DB: ':memory:' }))).toBe(MSG);
    expect(memoryDbRefusal(loadConfig({ NUDGE_DB: ' :memory: ' }))).toBe(MSG);
  });

  it('is allowed in demo mode (the e2e servers and screenshots use it)', () => {
    expect(memoryDbRefusal(loadConfig({ NUDGE_DB: ':memory:', NUDGE_DEMO: '1' }))).toBeNull();
  });

  it('is not what an unset or empty NUDGE_DB means: that is the default file', () => {
    for (const env of [{}, { NUDGE_DB: '' }]) {
      const c = loadConfig(env);
      expect(c.dbPath).toBe(DEFAULT_DB);
      expect(memoryDbRefusal(c)).toBeNull();
    }
    expect(memoryDbRefusal(loadConfig({ NUDGE_DB: '/srv/nudge/nudge.db' }))).toBeNull();
  });
});

describe('network config', () => {
  it('defaults to loopback with nothing extra allowed', () => {
    expect(loadConfig({})).toMatchObject({
      host: '127.0.0.1',
      allowedUsers: [],
      accessHosts: [],
      retiredVars: [],
    });
  });
  it('parses comma-separated lists and a custom bind host', () => {
    expect(
      loadConfig({
        NUDGE_HOST: '0.0.0.0',
        NUDGE_ACCESS_HOSTS: 'a.example.com, b.example.com ,',
        NUDGE_ALLOWED_USERS: 'm@x.com',
      }),
    ).toMatchObject({ host: '0.0.0.0', accessHosts: ['a.example.com', 'b.example.com'], allowedUsers: ['m@x.com'] });
  });
  it('notes, rather than reads, the retired Tailscale host setting', () => {
    const c = loadConfig({ NUDGE_ALLOWED_HOSTS: 'a.ts.net' });
    expect(c.retiredVars).toEqual(['NUDGE_ALLOWED_HOSTS']);
    expect(c).not.toHaveProperty('allowedHosts');
  });
  it('passes the Docker deployment variables straight through', () => {
    // What compose.yaml hands the container; nothing comes from a home directory.
    expect(
      loadConfig({
        NUDGE_HOST: '0.0.0.0',
        NUDGE_ACCESS_HOSTS: 'nudge.example.com',
        NUDGE_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        NUDGE_ACCESS_AUD: 'aud',
        NUDGE_ALLOWED_USERS: 'me@example.com',
        YOUTUBE_API_KEY: 'yt',
        NUDGE_GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
        NUDGE_GOOGLE_CLIENT_SECRET: 'sec',
      }),
    ).toMatchObject({
      dbPath: DEFAULT_DB,
      accessHosts: ['nudge.example.com'],
      accessTeamDomain: 'team.cloudflareaccess.com',
      accessAud: 'aud',
      allowedUsers: ['me@example.com'],
      envApiKey: 'yt',
      envGoogleClientId: 'id.apps.googleusercontent.com',
      envGoogleClientSecret: 'sec',
    });
  });
});
