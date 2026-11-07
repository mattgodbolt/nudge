import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig, resolveApiKey } from './config.js';
import { openRepo } from './db/repo.js';
import { createFakeClient } from './demo/fake-client.js';
import { nonDemoSources, seedDemo } from './demo/seed.js';
import { createWorld } from './demo/world.js';
import { createEventBus } from './events/bus.js';
import { createHandoffPoster } from './reply/poster.js';
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
  const repo = openRepo(config.dbPath);
  if (config.demo) {
    const foreign = nonDemoSources(repo);
    if (foreign.length) {
      console.error(
        `Refusing to start in YOUTUBEY_DEMO mode: ${config.dbPath} already contains non-demo sources ` +
          `(${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', ...' : ''}).\n` +
          'Demo mode would sync fake data into your real database. Set YOUTUBEY_DB=data/demo.db (or :memory:).',
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
  if (config.demo) {
    const world = createWorld();
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

  if (config.demo) await seedDemo(repo, addSource); // no-op unless the DB is empty

  const staticDir = findStaticDir();
  const app = buildApp(
    {
      repo,
      engine,
      bus,
      quota,
      poster: createHandoffPoster(repo),
      addSource,
      testKey: config.demo ? async () => ({ ok: true, message: 'Demo mode: no YouTube calls are made' }) : testKey,
      onSettingsChanged: () => scheduler.start(),
      resolveApiKey: resolveKey,
      demo: config.demo,
      demoTick,
      staticDir,
    },
    { port: config.port || undefined },
  );

  await app.listen({ host: '127.0.0.1', port: config.port });
  const port = (app.server.address() as { port: number }).port;
  scheduler.start();
  console.log(
    `Youtubey listening on http://127.0.0.1:${port}` +
      `${config.demo ? ' (DEMO mode)' : ''}${staticDir ? '' : ' (no built web UI found; run `npm run build` or use vite dev)'}`,
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, shutting down`);
    scheduler.stop();
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
