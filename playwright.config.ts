import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

// Build the web bundle once, here, rather than in each demo server's start command: eight concurrent `vite build`s into
// the same dist/web (each emptying it first) could hand a server a half-written bundle. The env flag stops the workers,
// which load this file again, from rebuilding.
if (!process.env.NUDGE_E2E_BUILT) {
  execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
  process.env.NUDGE_E2E_BUILT = '1';
}

const use = { permissions: ['clipboard-read', 'clipboard-write'] };

// Three demo servers, so specs that change shared state cannot disturb each other (the specs run in parallel):
// hand-off mode (4518, the default), API-posting mode (4519, NUDGE_DEMO_POST=api) for reply-api.spec.ts, and a private
// one (4520) for snooze.spec.ts, which reorders the inbox and moves counts, and one (4521,
// NUDGE_DEMO_GITHUB=1) with a fake GitHub feed for github.spec.ts, and one (4522) for assistant.spec.ts, which adds todos, and one (4523, NUDGE_DEMO_SUGGEST=1) with the fake suggestion
// source for suggestions.spec.ts, and one (4525, as 4524 plus a 300-item backlog and a daily cap that bites after 1,100 suggestions) for backlog.spec.ts, and one (4524, as 4523 plus NUDGE_DEMO_COMMENTS=1: GitHub items with comment threads) for notes.spec.ts, which snoozes items, records notes and edits them.
export default defineConfig({
  testDir: 'e2e',
  projects: [
    {
      name: 'handoff',
      testIgnore:
        /(inbox|reply-api|snooze|snooze-activity|github|assistant|suggestions|notes|backlog|update|adventure)\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4518' },
    },
    {
      // inbox.spec.ts marks items done and snoozes them; on the shared 4518 server that emptied rows out from under the
      // specs there (a long-pressed row vanishing mid-test, stats totals moving), so it has a server of its own.
      name: 'triage',
      testMatch: /inbox\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4526' },
    },
    {
      name: 'organise',
      testMatch: /snooze\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4520' },
    },
    {
      // Snoozing until activity: comments are delivered on demand and the snooze waker is run as if days had passed.
      name: 'activity',
      testMatch: /snooze-activity\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4528' },
    },
    {
      name: 'api',
      testMatch: /reply-api\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4519' },
    },
    {
      name: 'assistant',
      testMatch: /assistant\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4522' },
    },
    {
      name: 'suggestions',
      testMatch: /suggestions\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4523' },
    },
    {
      name: 'notes',
      testMatch: /notes\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4524' },
    },
    {
      name: 'backlog',
      testMatch: /backlog\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4525' },
    },
    {
      // A server that claims a newer web build than the page loaded, to show the "New version available" prompt.
      name: 'update',
      testMatch: /update\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4527' },
    },
    {
      // Adventure mode: levels earned from triage, a demo clock for missed campfire days, and the off switch.
      name: 'adventure',
      testMatch: /adventure\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4529' },
    },
    {
      name: 'github',
      testMatch: /github\.spec\.ts/,
      use: { ...use, baseURL: 'http://127.0.0.1:4521' },
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
      command: 'npm run demo:e2e:triage',
      url: 'http://127.0.0.1:4526/api/bootstrap',
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
      command: 'npm run demo:e2e:activity',
      url: 'http://127.0.0.1:4528/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:api',
      url: 'http://127.0.0.1:4519/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:assistant',
      url: 'http://127.0.0.1:4522/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:suggest',
      url: 'http://127.0.0.1:4523/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:notes',
      url: 'http://127.0.0.1:4524/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:backlog',
      url: 'http://127.0.0.1:4525/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:update',
      url: 'http://127.0.0.1:4527/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:adventure',
      url: 'http://127.0.0.1:4529/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: 'npm run demo:e2e:github',
      url: 'http://127.0.0.1:4521/api/bootstrap',
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
