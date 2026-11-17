import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import type { AppDeps, GoogleAuth, PostGateway, ReplyPoster } from './contracts.js';
import { createGoogleAuth } from './auth/google.js';
import { checkExposure, securityOptions } from './security.js';
import { loadConfig, memoryDbRefusal, resolveApiKey, resolveGoogleClient } from './config.js';
import { openDb } from './db/db.js';
import { createRepo } from './db/repo.js';
import { createRpgReader } from './db/rpg.js';
import { createInsightsReader } from './db/insights.js';
import { createFakeClient } from './demo/fake-client.js';
import { createFakeGithubClient, DEMO_GITHUB_OWNER } from './demo/github.js';
import { createFakeLlmClient, createFakeSnoozeAi } from './demo/llm.js';
import { createSnoozeAi } from './classify/snooze.js';
import { createDemoClassifier, demoCapUsd } from './demo/suggest.js';
import { createSuggestWorker } from './suggest/worker.js';
import { createLlmClient } from './providers/anthropic/client.js';
import { decorateDemo, nonDemoSources, seedDemo, seedDemoOwner } from './demo/seed.js';
import { ownerProfileWarning } from './startup.js';
import { seedDemoHistory } from './demo/history.js';
import { createDemoPosting } from './demo/post.js';
import { createWorld } from './demo/world.js';
import { createEventBus } from './events/bus.js';
import { createHttpPostGateway } from './reply/gateway.js';
import { createHandoffPoster, createReplyPoster } from './reply/poster.js';
import { buildSettingsDto } from './routes/util.js';
import { backfillVideoDetails } from './sync/membership.js';
import { createPushNotifier } from './push/notifier.js';
import { createWebPushSender, ensureVapidKeys } from './push/sender.js';
import { createGithubClient } from './providers/github/client.js';
import { createGithubPoller } from './sync/github.js';
import { createSnoozeWaker } from './sync/snooze.js';
import { createSyncEngine } from './sync/engine.js';
import { createQuotaTracker } from './sync/quota.js';
import { createScheduler } from './sync/scheduler.js';
import { createAddSource } from './sync/sources.js';
import { createHttpClient, testKey } from './youtube/client.js';
import { createBuildId } from './build.js';
import { resolveVersion } from './version.js';

/** dist/web sits next to server/ (tsx) or three levels up from dist/server/server/ (compiled). */
function findStaticDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // An e2e run with a port offset builds into a directory of its own (see playwright.config.ts).
  const own = process.env.NUDGE_WEB_DIR;
  for (const rel of own ? [`../${own}`] : ['../dist/web', '../../../dist/web']) {
    const dir = join(here, rel);
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const exposure = checkExposure(config);
  if (exposure.fatal) {
    console.error(exposure.fatal);
    process.exit(1);
  }
  for (const w of exposure.warnings) console.warn(w);
  const dbRefusal = memoryDbRefusal(config);
  if (dbRefusal) {
    console.error(`${dbRefusal}. Set NUDGE_DB to a file path, or leave it unset for data/nudge.db.`);
    process.exit(1);
  }
  // Demo servers can be told that days have passed, for one sweep (e2e checks what a snooze does at its fallback date).
  let demoSkewMs = 0;
  // Adventure mode's own clock can run ahead in demo mode only, to show a missed campfire day in e2e.
  let rpgSkewMs = 0;
  const db = openDb(config.dbPath);
  const repo = createRepo(db, config.demo ? () => new Date(Date.now() + demoSkewMs) : undefined);
  const rpg = createRpgReader(db, () => new Date(Date.now() + demoSkewMs + rpgSkewMs));
  const insights = createInsightsReader(db, () => new Date(Date.now() + demoSkewMs));
  if (config.demo) {
    const foreign = nonDemoSources(repo);
    if (foreign.length) {
      console.error(
        `Refusing to start in NUDGE_DEMO mode: ${config.dbPath} already contains non-demo sources ` +
          `(${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', ...' : ''}).\n` +
          'Demo mode would sync fake data into your real database. Set NUDGE_DB=data/demo.db, or NUDGE_DB=:memory: ' +
          '(allowed only in demo mode: its data is gone when the process exits).',
      );
      repo.close();
      process.exit(1);
    }
  }
  const bus = createEventBus();

  const resolveKey = () =>
    // Demo mode never calls YouTube, so pretend a key is configured to skip onboarding.
    config.demo ? { key: 'demo', source: 'env' as const } : resolveApiKey(config, repo);

  const quota = createQuotaTracker({ repo, getSettings: () => repo.getSettings() });

  let demoTick: (() => void) | undefined;
  let yt;
  const world = config.demo ? createWorld() : null;
  if (config.demo && world) {
    const fake = createFakeClient(world, { live: !config.demoClockFixed });
    yt = fake;
    demoTick = () => {
      fake.tick();
      if (fakeGithub) {
        fakeGithub.tick();
        void github.pollNow();
      }
    };
  } else {
    yt = createHttpClient({ getApiKey: () => resolveKey().key, quota });
  }

  const engine = createSyncEngine({ repo, yt, quota, bus, currentKey: () => resolveKey().key });
  const addSource = createAddSource({ repo, yt, engine });
  const scheduler = createScheduler({
    repo,
    engine,
    quota,
    getSettings: () => repo.getSettings(),
    hasApiKey: () => resolveKey().key !== null,
  });

  const snoozeWaker = createSnoozeWaker({ repo, bus });

  // GitHub feeds poll on their own schedule, independent of YouTube's key and quota. Demo mode never leaves the box.
  // NUDGE_DEMO_COMMENTS=1 gives some of the fake items a comment thread, ending on the owner's or on someone else's.
  const demoComments = config.demo && process.env.NUDGE_DEMO_COMMENTS === '1';
  const demoBacklog = config.demo ? Number(process.env.NUDGE_DEMO_BACKLOG ?? 0) || 0 : 0;
  const fakeGithub = config.demo
    ? createFakeGithubClient(Date.now, { comments: demoComments, backlog: demoBacklog })
    : null;
  const githubClient = fakeGithub ? fakeGithub.client : createGithubClient();
  const github = createGithubPoller({ repo, bus, client: githubClient });
  if (fakeGithub && process.env.NUDGE_DEMO_GITHUB === '1' && repo.listFeeds().length === 0) {
    repo.addFeed({ owner: DEMO_GITHUB_OWNER, prs: true, issues: true, importMode: 'all' });
  }

  if (demoComments && repo.getSettings().github.myAccounts.length === 0) {
    repo.updateSettings({ github: { ...repo.getSettings().github, myAccounts: ['demo-owner'] } });
  }

  // Demo mode works out of the box: a made-up owner, so the model-backed features (all faked) are not paused.
  if (config.demo) seedDemoOwner(repo);
  const ownerWarning = ownerProfileWarning(repo.getSettings());
  if (ownerWarning) console.warn(ownerWarning);

  const llm = config.demo ? createFakeLlmClient() : createLlmClient();
  const snoozeAi = config.demo ? createFakeSnoozeAi() : createSnoozeAi();

  // Advisory suggestions on inbox items. Demo mode only runs them (with a fake, offline classifier) when asked to, so
  // the other demo servers and tests are untouched. Off entirely without an API key.
  const demoSuggest = config.demo && process.env.NUDGE_DEMO_SUGGEST === '1';
  const demoCapAfter = demoSuggest ? Number(process.env.NUDGE_DEMO_SUGGEST_CAP_AFTER ?? 0) || 0 : 0;
  const suggestWorker = createSuggestWorker({
    repo,
    bus,
    githubClient,
    getApiKey: config.demo ? () => (demoSuggest ? 'demo' : null) : () => repo.getSettings().llm.apiKey,
    ...(config.demo ? { makeClassifier: () => createDemoClassifier({ priced: demoCapAfter > 0 }) } : {}),
    // NUDGE_DEMO_SUGGEST_CAP_AFTER=N: the daily cap bites after N model calls, so a demo can show the paused state.
    ...(demoSuggest && demoCapAfter > 0 ? { dailyCapUsd: demoCapUsd(demoCapAfter) } : {}),
    ...(demoSuggest ? { startDelayMs: 500, debounceMs: 200, passCap: demoBacklog > 0 ? 50 : 2000 } : {}),
  });

  const vapid = ensureVapidKeys(repo);
  const push = createPushNotifier({
    repo,
    bus,
    publicKey: vapid.publicKey,
    sender: createWebPushSender({ keys: vapid, subject: config.pushSubject }),
  });

  if (config.demo) {
    const fresh = repo.listSources().length === 0;
    await seedDemo(repo, addSource); // no-op unless the DB is empty
    if (fresh) {
      // Snoozes need comments, which arrive with the first syncs: decorate once there are enough.
      const stop = bus.subscribe((e) => {
        if (e.type !== 'sync.done' || !decorateDemo(repo)) return;
        stop();
        bus.emit({ type: 'inbox.changed', counts: repo.counts(), addedIds: [], changedIds: [] });
      });
      // NUDGE_DEMO_HISTORY=1: weeks of made-up history for the Insights section, once the decoration above is in
      // and (with the fake GitHub feed) its items have arrived too.
      if (process.env.NUDGE_DEMO_HISTORY === '1') {
        const stopHistory = bus.subscribe((e) => {
          if (e.type !== 'sync.done' && e.type !== 'inbox.changed') return;
          if (repo.counts().snoozed === 0) return;
          if (repo.listFeeds().length > 0 && Object.keys(repo.counts().byRepo).length === 0) return;
          if (!seedDemoHistory(db)) return;
          stopHistory();
          bus.emit({ type: 'inbox.changed', counts: repo.counts(), addedIds: [], changedIds: [] });
        });
      }
    }
  }

  // The listening port is only known after listen() (NUDGE_PORT=0 in tests), so the redirect URI is a getter.
  let listenPort = config.port;
  // Assigned just below; auth's onChange and the poster refer to each other, so both read this lazily.
  let poster: ReplyPoster | undefined;
  const onAuthChange = () => {
    if (!poster) return;
    bus.emit({ type: 'capabilities.changed', capabilities: poster.capabilities() });
    bus.emit({ type: 'settings.changed', settings: buildSettingsDto(deps) });
  };

  let auth: GoogleAuth;
  let gateway: PostGateway;
  if (config.demo && process.env.NUDGE_DEMO_POST === 'api') {
    // Demo "API" posting: a fake GoogleAuth (starts connected as the demo channel) + a gateway that appends to the world.
    ({ auth, gateway } = createDemoPosting({ repo, world: world!, onChange: onAuthChange }));
  } else {
    gateway = createHttpPostGateway();
    auth = createGoogleAuth({
      repo,
      gateway,
      getClient: () => resolveGoogleClient(config, repo),
      redirectUri: () => `http://127.0.0.1:${listenPort}/api/auth/callback`,
      onChange: onAuthChange,
      addSource,
      quota,
    });
  }
  const replyPoster = createReplyPoster({ repo, auth, quota, gateway, handoff: createHandoffPoster(repo) });
  poster = replyPoster;

  const staticDir = findStaticDir();
  const deps: AppDeps = {
    repo,
    engine,
    bus,
    quota,
    poster: replyPoster,
    auth,
    addSource,
    testKey: config.demo ? async () => ({ ok: true, message: 'Demo mode: no YouTube calls are made' }) : testKey,
    onSettingsChanged: () => {
      scheduler.start();
      suggestWorker.kick();
    },
    backfillDetails: () => backfillVideoDetails(repo, yt),
    push,
    github,
    githubClient,
    llm,
    snoozeAi,
    suggest: suggestWorker,
    resolveApiKey: resolveKey,
    demo: config.demo,
    version: resolveVersion(),
    demoTick,
    demoControls:
      config.demo && world
        ? {
            async comment(itemId, me) {
              if (itemId.startsWith('gh:')) {
                if (!fakeGithub?.comment(itemId, me ? 'demo-owner' : 'alice-maintainer')) return false;
                await github.pollNow();
                return true;
              }
              const video = world.reply(itemId, new Date());
              if (!video) return false;
              await engine.run({ trigger: 'manual', scope: 'video', id: video });
              return true;
            },
            rpgSkewHours(hours) {
              rpgSkewMs = hours * 3_600_000;
            },
            advanceDays(days) {
              // One sweep sees the later date, then the clock is real again (new snoozes are made against real time).
              demoSkewMs = days * 86_400_000;
              try {
                snoozeWaker.sweep();
              } finally {
                demoSkewMs = 0;
              }
            },
          }
        : undefined,
    rpg,
    insights,
    staticDir,
    // A demo server may claim a different build (NUDGE_DEMO_BUILD_ID) so the "new version" prompt can be shown in e2e.
    buildId: createBuildId(staticDir, config.demo ? process.env.NUDGE_DEMO_BUILD_ID : undefined),
  };
  const app = buildApp(deps, securityOptions(config));

  await app.listen({ host: config.host, port: config.port });
  const port = (app.server.address() as { port: number }).port;
  listenPort = port;
  scheduler.start();
  snoozeWaker.start();
  github.start();
  suggestWorker.start();
  // Videos stored before duration/likes were tracked: fill them in once, quietly (best effort; the Stats page can retry).
  if (resolveKey().key) {
    backfillVideoDetails(repo, yt).catch((e: unknown) =>
      console.warn('Video detail backfill failed:', e instanceof Error ? e.message : e),
    );
  }
  console.log(
    `Nudge listening on http://${config.host}:${port}` +
      `${config.demo ? ' (DEMO mode)' : ''}${staticDir ? '' : ' (no built web UI found; run `npm run build` or use vite dev)'}`,
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, shutting down`);
    scheduler.stop();
    snoozeWaker.stop();
    github.stop();
    suggestWorker.stop();
    push.stop();
    await app.close();
    repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Every background loop catches its own failures; anything that still escapes is a bug. Say so and exit, so the
// supervisor (Docker's restart policy) starts a clean process, rather than dying with no word of why.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection; exiting:', err);
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
