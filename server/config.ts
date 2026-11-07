import { readFileSync } from 'node:fs';
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Config {
  const port = env.YOUTUBEY_PORT ? Number(env.YOUTUBEY_PORT) : 4517;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid YOUTUBEY_PORT: ${env.YOUTUBEY_PORT}`);
  }
  const truthy = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';
  return {
    port,
    dbPath: env.YOUTUBEY_DB || 'data/youtubey.db',
    demo: truthy(env.YOUTUBEY_DEMO),
    demoClockFixed: env.YOUTUBEY_DEMO_CLOCK === 'fixed',
    envApiKey: env.YOUTUBE_API_KEY?.trim() || null,
    keyFile: join(home, '.youtubey-key'),
    envGoogleClientId: env.YOUTUBEY_GOOGLE_CLIENT_ID?.trim() || null,
    envGoogleClientSecret: env.YOUTUBEY_GOOGLE_CLIENT_SECRET?.trim() || null,
    googleClientFile: join(home, '.youtubey-google-client.json'),
  };
}

/** Key resolution order: env > settings (DB) > ~/.youtubey-key. Never serialise `key` to clients. */
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

/** Order: env > settings (DB) > ~/.youtubey-google-client.json. Never serialise the secret to clients. */
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
