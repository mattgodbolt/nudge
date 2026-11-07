import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Repo } from './contracts.js';
import { parseGoogleClientJson } from './reply/google-client.js';

export interface Config {
  port: number;
  dbPath: string;
  demo: boolean;
  /** Demo world does not grow on its own (deterministic e2e). */
  demoClockFixed: boolean;
  envApiKey: string | null;
  keyFile: string;
  envGoogleClientId: string | null;
  envGoogleClientSecret: string | null;
  googleClientFile: string;
}

export type ApiKeySource = 'env' | 'settings' | 'file';

/** The app used to be called Youtubey: NUDGE_* wins, YOUTUBEY_* still works so existing setups keep running. */
const pick = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  env[`NUDGE_${name}`] ?? env[`YOUTUBEY_${name}`];

/** Prefer ~/.nudge-<name>; fall back to the pre-rename ~/.youtubey-<name> when only that exists. */
function homeFile(home: string, name: string): string {
  const current = join(home, `.nudge-${name}`);
  const legacy = join(home, `.youtubey-${name}`);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export const DEFAULT_DB = 'data/nudge.db';

/** One-off: the default database used to be data/youtubey.db. Move it (and WAL/SHM) before it is opened. */
export function migrateLegacyDb(dbPath: string, legacyPath = 'data/youtubey.db'): boolean {
  if (dbPath !== DEFAULT_DB || existsSync(dbPath) || !existsSync(legacyPath)) return false;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(legacyPath + suffix)) renameSync(legacyPath + suffix, dbPath + suffix);
  }
  return true;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Config {
  const portEnv = pick(env, 'PORT');
  const port = portEnv ? Number(portEnv) : 4517;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid NUDGE_PORT: ${portEnv}`);
  }
  const truthy = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';
  return {
    port,
    dbPath: pick(env, 'DB') || DEFAULT_DB,
    demo: truthy(pick(env, 'DEMO')),
    demoClockFixed: pick(env, 'DEMO_CLOCK') === 'fixed',
    envApiKey: env.YOUTUBE_API_KEY?.trim() || null,
    keyFile: homeFile(home, 'key'),
    envGoogleClientId: pick(env, 'GOOGLE_CLIENT_ID')?.trim() || null,
    envGoogleClientSecret: pick(env, 'GOOGLE_CLIENT_SECRET')?.trim() || null,
    googleClientFile: homeFile(home, 'google-client.json'),
  };
}

/** Key resolution order: env > settings (DB) > ~/.nudge-key. Never serialise `key` to clients. */
export function resolveApiKey(
  config: Pick<Config, 'envApiKey' | 'keyFile'>,
  repo: Pick<Repo, 'getSettings'>,
): { key: string | null; source: ApiKeySource | null } {
  if (config.envApiKey) return { key: config.envApiKey, source: 'env' };
  const stored = repo.getSettings().apiKey?.trim();
  if (stored) return { key: stored, source: 'settings' };
  try {
    const fromFile = readFileSync(config.keyFile, 'utf8').trim();
    if (fromFile) return { key: fromFile, source: 'file' };
  } catch {
    // no key file: fine
  }
  return { key: null, source: null };
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  source: ApiKeySource;
}

/** Order: env > settings (DB) > ~/.nudge-google-client.json. Never serialise the secret to clients. */
export function resolveGoogleClient(
  config: Pick<Config, 'envGoogleClientId' | 'envGoogleClientSecret' | 'googleClientFile'>,
  repo: Pick<Repo, 'getSettings'>,
): GoogleClient | null {
  if (config.envGoogleClientId && config.envGoogleClientSecret) {
    return { clientId: config.envGoogleClientId, clientSecret: config.envGoogleClientSecret, source: 'env' };
  }
  const stored = repo.getSettings().googleClient;
  if (stored?.clientId && stored.clientSecret) return { ...stored, source: 'settings' };
  try {
    const parsed = parseGoogleClientJson(readFileSync(config.googleClientFile, 'utf8'));
    if (parsed) return { ...parsed, source: 'file' };
  } catch {
    // no client file: fine
  }
  return null;
}
