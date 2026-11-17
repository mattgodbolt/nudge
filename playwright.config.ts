import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

// Build the web bundle once, here, rather than in each demo server's start command: eight concurrent `vite build`s into
// the same dist/web (each emptying it first) could hand a server a half-written bundle. The env flag stops the workers,
// which load this file again, from rebuilding.
//
// Two suites can run side by side (say, two agents in two checkouts, or one in a scratch copy) if each sets
// E2E_PORT_OFFSET to a different multiple of 100: every demo server's port moves by it, and the bundle goes to its own
// directory (NUDGE_WEB_DIR), so neither run can clash on a port or overwrite the other's build.
const OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0);
if (!Number.isInteger(OFFSET) || OFFSET < 0 || OFFSET > 40000) throw new Error('E2E_PORT_OFFSET must be an integer');
const port = (n: number) => n + OFFSET;
const base = (n: number) => `http://127.0.0.1:${port(n)}`;
if (OFFSET) process.env.NUDGE_WEB_DIR = `dist/web-e2e-${OFFSET}`;
if (!process.env.NUDGE_E2E_BUILT) {
  execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
  process.env.NUDGE_E2E_BUILT = '1';
}

const use = {
  permissions: ['clipboard-read', 'clipboard-write'],
  // Something to look at when a test fails (CI uploads test-results/ and the report).
  trace: 'retain-on-failure' as const,
  screenshot: 'only-on-failure' as const,
};

// Several demo servers, so specs that change shared state cannot disturb each other (the specs run in parallel). Each
// row is one server, the Playwright project that talks to it, and the spec it exists for (`spec` is the file name
// without `.spec.ts`; the `handoff` project, on the first row, takes every spec no other row claims).
interface Server {
  name: string;
  port: number;
  spec?: string;
  env?: Record<string, string>;
}
const servers: Server[] = [
  { name: 'handoff', port: 4518 },
  // inbox.spec.ts marks items done and snoozes them; on the shared 4518 server that emptied rows out from under the
  // specs there (a long-pressed row vanishing mid-test, stats totals moving), so it has a server of its own.
  { name: 'triage', port: 4526, spec: 'inbox' },
  { name: 'organise', port: 4520, spec: 'snooze' },
  // Snoozing until activity: comments are delivered on demand and the snooze waker is run as if days had passed.
  { name: 'activity', port: 4528, spec: 'snooze-activity', env: { NUDGE_DEMO_GITHUB: '1', NUDGE_DEMO_COMMENTS: '1' } },
  { name: 'api', port: 4519, spec: 'reply-api', env: { NUDGE_DEMO_POST: 'api' } },
  { name: 'assistant', port: 4522, spec: 'assistant' },
  { name: 'suggestions', port: 4523, spec: 'suggestions', env: { NUDGE_DEMO_GITHUB: '1', NUDGE_DEMO_SUGGEST: '1' } },
  {
    name: 'notes',
    port: 4524,
    spec: 'notes',
    env: { NUDGE_DEMO_GITHUB: '1', NUDGE_DEMO_SUGGEST: '1', NUDGE_DEMO_COMMENTS: '1' },
  },
  {
    name: 'backlog',
    port: 4525,
    spec: 'backlog',
    env: {
      NUDGE_DEMO_GITHUB: '1',
      NUDGE_DEMO_SUGGEST: '1',
      NUDGE_DEMO_COMMENTS: '1',
      NUDGE_DEMO_BACKLOG: '300',
      NUDGE_DEMO_SUGGEST_CAP_AFTER: '1100',
    },
  },
  // A server that claims a newer web build than the page loaded, to show the "New version available" prompt.
  { name: 'update', port: 4527, spec: 'update', env: { NUDGE_DEMO_BUILD_ID: '/assets/index-e2e-newer.js' } },
  // Adventure mode: levels earned from triage, a demo clock for missed campfire days, and the off switch.
  { name: 'adventure', port: 4529, spec: 'adventure' },
  // Insights on Stats: a demo with weeks of made-up history plus the fake GitHub feed.
  { name: 'insights', port: 4530, spec: 'insights', env: { NUDGE_DEMO_GITHUB: '1', NUDGE_DEMO_HISTORY: '1' } },
  // Live updates: items are finished "on another device" through the API while the page is mid-list or reading.
  { name: 'live', port: 4531, spec: 'live' },
  // own-channel.spec.ts un-marks and re-marks the demo's own channel; on the shared 4518 server that raced
  // stats.spec.ts, whose "My channels" scope switch is only offered while a channel is marked as mine.
  { name: 'channel', port: 4532, spec: 'own-channel' },
  { name: 'github', port: 4521, spec: 'github', env: { NUDGE_DEMO_GITHUB: '1' } },
];
const claimed = servers.flatMap((s) => (s.spec ? [s.spec] : []));

export default defineConfig({
  testDir: 'e2e',
  // A run with an offset gets its own output folder too, so two runs in one checkout do not clear each other's.
  outputDir: OFFSET ? `test-results-${OFFSET}` : 'test-results',
  // A stray test.only must not turn a CI run green while skipping everything else.
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  projects: servers.map((s) => ({
    name: s.name,
    ...(s.spec
      ? { testMatch: new RegExp(`${s.spec}\\.spec\\.ts`) }
      : { testIgnore: new RegExp(`(${claimed.join('|')})\\.spec\\.ts`) }),
    use: { ...use, baseURL: base(s.port) },
  })),
  webServer: servers.map((s) => ({
    command: 'npx tsx server/index.ts',
    env: {
      NUDGE_DEMO: '1',
      NUDGE_DB: ':memory:',
      NUDGE_DEMO_CLOCK: 'fixed',
      ...s.env,
      NUDGE_PORT: String(port(s.port)),
    },
    url: `${base(s.port)}/api/bootstrap`,
    reuseExistingServer: false,
    timeout: 120000,
  })),
});
