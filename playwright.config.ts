import { defineConfig } from '@playwright/test';

const use = { permissions: ['clipboard-read', 'clipboard-write'] };

// Three demo servers, so specs that change shared state cannot disturb each other (the specs run in parallel):
// hand-off mode (4518, the default), API-posting mode (4519, NUDGE_DEMO_POST=api) for reply-api.spec.ts, and a private
// one (4520) for snooze-labels.spec.ts, which reorders the inbox, labels comments and moves counts.
export default defineConfig({
  testDir: 'e2e',
  projects: [
    {
      name: 'handoff',
      testIgnore: /(reply-api|snooze-labels)\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4518' },
    },
    {
      name: 'organise',
      testMatch: /snooze-labels\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4520' },
    },
    {
      name: 'api',
      testMatch: /reply-api\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4519' },
    },
  ],
  webServer: [
    {
      command: 'npm run demo:e2e',
      url: 'http://127.0.0.1:4518/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:organise',
      url: 'http://127.0.0.1:4520/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:api',
      url: 'http://127.0.0.1:4519/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
