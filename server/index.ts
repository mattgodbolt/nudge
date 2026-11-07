import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import type { AppDeps, GoogleAuth, PostGateway, ReplyPoster } from './contracts.js';
import { createGoogleAuth } from './auth/google.js';
import { loadConfig, migrateLegacyDb, resolveApiKey, resolveGoogleClient } from './config.js';
import { openRepo } from './db/repo.js';
import { createFakeClient } from './demo/fake-client.js';
import { decorateDemo, nonDemoSources, seedDemo } from './demo/seed.js';
import { createDemoPosting } from './demo/post.js';
import { createWorld } from './demo/world.js';
import { createEventBus } from './events/bus.js';
import { createHttpPostGateway } from './reply/gateway.js';
import { createHandoffPoster, createReplyPoster } from './reply/poster.js';
import { buildSettingsDto } from './routes/util.js';
import { backfillVideoDetails } from './sync/membership.js';
import { createSnoozeWaker } from './sync/snooze.js';
import { createSyncEngine } from './sync/engine.js';
import { createQuotaTracker } from './sync/quota.js';
import { createScheduler } from './sync/scheduler.js';
import { createAddSource } from './sync/sources.js';
import { createHttpClient, testKey } from './youtube/client.js';

/** dist/web sits next to server/ (tsx) or three levels up from dist/server/server/ (compiled). */
function findStaticDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../dist/web', '../../../dist/web']) {
    const dir = join(here, rel);
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (migrateLegacyDb(config.dbPath)) console.log('Moved data/youtubey.db to data/nudge.db');
  const repo = openRepo(config.dbPath);
  if (config.demo) {
    const foreign = nonDemoSources(repo);
    if (foreign.length) {
      console.error(
        `Refusing to start in NUDGE_DEMO mode: ${config.dbPath} already contains non-demo sources ` +
          `(${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', ...' : ''}).\n` +
          'Demo mode would sync fake data into your real database. Set NUDGE_DB=data/demo.db (or :memory:).',
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
    demoTick = () => fake.tick();
  } else {
    yt = createHttpClient({ getApiKey: () => resolveKey().key, quota });
  }

  const engine = createSyncEngine({ repo, yt, quota, bus });
  const addSource = createAddSource({ repo, yt, engine });
  const scheduler = createScheduler({
    repo,
    engine,
    quota,
    getSettings: () => repo.getSettings(),
    hasApiKey: () => resolveKey().key !== null,
  });

  const snoozeWaker = createSnoozeWaker({ repo, bus });

  if (config.demo) {
    const fresh = repo.listSources().length === 0;
    await seedDemo(repo, addSource); // no-op unless the DB is empty
    if (fresh) {
      // Labels and snoozes need comments, which arrive with the first syncs: decorate once there are enough.
      const stop = bus.subscribe((e) => {
        if (e.type !== 'sync.done' || !decorateDemo(repo)) return;
        stop();
        bus.emit({ type: 'labels.changed', labels: repo.listLabels() });
        bus.emit({ type: 'inbox.changed', counts: repo.counts(), addedIds: [], changedIds: [] });
      });
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
  if (config.demo && (process.env.NUDGE_DEMO_POST ?? process.env.YOUTUBEY_DEMO_POST) === 'api') {
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
    onSettingsChanged: () => scheduler.start(),
    backfillDetails: () => backfillVideoDetails(repo, yt),
    resolveApiKey: resolveKey,
    demo: config.demo,
    demoTick,
    staticDir,
  };
  const app = buildApp(deps, {
    port: config.port || undefined,
    allowedHosts: config.allowedHosts,
    allowedUsers: config.allowedUsers,
  });

  await app.listen({ host: config.host, port: config.port });
  const port = (app.server.address() as { port: number }).port;
  listenPort = port;
  scheduler.start();
  snoozeWaker.start();
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
    await app.close();
    repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
