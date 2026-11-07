import { defineConfig } from '@playwright/test';

const use = { permissions: ['clipboard-read', 'clipboard-write'] };

// Two demo servers: hand-off mode (4518, the default) and API-posting mode (4519, YOUTUBEY_DEMO_POST=api).
// reply-api.spec.ts runs only against the second.
export default defineConfig({
  testDir: 'e2e',
  projects: [
    {
      name: 'handoff',
      testIgnore: /reply-api\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4518' },
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
      command: 'npm run demo:e2e:api',
      url: 'http://127.0.0.1:4519/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
