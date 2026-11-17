import type { Repo } from './contracts.js';

export interface Config {
  port: number;
  /** Listen address. Loopback unless a container publishes the port (then 0.0.0.0 inside, loopback on the host). */
  host: string;
  /** Emails allowed in through Cloudflare Access (exact, case-insensitive), checked against the verified token. */
  allowedUsers: string[];
  /** Hostnames fronted by Cloudflare Access: the only names accepted in Host besides loopback. */
  accessHosts: string[];
  /** Variables that are set but no longer read (e.g. NUDGE_ALLOWED_HOSTS from the Tailscale days), to warn about. */
  retiredVars: string[];
  /** Cloudflare Access team domain (`<team>.cloudflareaccess.com`) and the Access application's audience tag. */
  accessTeamDomain: string;
  accessAud: string;
  /** Contact (mailto: or https: URL) given to push services in VAPID requests. */
  pushSubject: string;
  dbPath: string;
  demo: boolean;
  /** Demo world does not grow on its own (deterministic e2e). */
  demoClockFixed: boolean;
  envApiKey: string | null;
  envGoogleClientId: string | null;
  envGoogleClientSecret: string | null;
}

export type ApiKeySource = 'env' | 'settings';

const pick = (env: NodeJS.ProcessEnv, name: string): string | undefined => env[`NUDGE_${name}`];

export const DEFAULT_DB = 'data/nudge.db';

/**
 * Settings that used to mean something and no longer do. ALLOWED_HOSTS named the `tailscale serve` hostname; Tailscale
 * is no longer a way in (Cloudflare Access is), so it is ignored. A deployment whose .env still sets it must keep
 * starting, so it only earns a warning.
 */
const RETIRED = ['ALLOWED_HOSTS'];

/**
 * Why the server must not start on this database, or null. An in-memory database is gone when the process exits, so
 * only demo mode (the e2e servers, screenshots) may use one: a real instance that lost everything on a restart would
 * look like it worked until then.
 */
export function memoryDbRefusal(config: Pick<Config, 'dbPath' | 'demo'>): string | null {
  if (config.demo || config.dbPath.trim() !== ':memory:') return null;
  return 'NUDGE_DB=:memory: would lose all data when the process exits; it is only allowed in demo mode';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portEnv = pick(env, 'PORT');
  const port = portEnv ? Number(portEnv) : 4517;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid NUDGE_PORT: ${portEnv}`);
  }
  const truthy = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    port,
    host: pick(env, 'HOST') || '127.0.0.1',
    allowedUsers: list(pick(env, 'ALLOWED_USERS')),
    retiredVars: RETIRED.filter((name) => pick(env, name) !== undefined).map((name) => `NUDGE_${name}`),
    accessHosts: list(pick(env, 'ACCESS_HOSTS')).map((h) =>
      h
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[/:.]+$/, '')
        .replace(/:\d+$/, ''),
    ),
    accessTeamDomain: (pick(env, 'ACCESS_TEAM_DOMAIN') ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, ''),
    accessAud: pick(env, 'ACCESS_AUD')?.trim() ?? '',
    pushSubject: pick(env, 'PUSH_SUBJECT')?.trim() || 'mailto:nudge@example.invalid',
    dbPath: pick(env, 'DB')?.trim() || DEFAULT_DB,
    demo: truthy(pick(env, 'DEMO')),
    demoClockFixed: pick(env, 'DEMO_CLOCK') === 'fixed',
    envApiKey: env.YOUTUBE_API_KEY?.trim() || null,
    envGoogleClientId: pick(env, 'GOOGLE_CLIENT_ID')?.trim() || null,
    envGoogleClientSecret: pick(env, 'GOOGLE_CLIENT_SECRET')?.trim() || null,
  };
}

/** Key resolution order: env > settings (DB). Never serialise `key` to clients. */
export function resolveApiKey(
  config: Pick<Config, 'envApiKey'>,
  repo: Pick<Repo, 'getSettings'>,
): { key: string | null; source: ApiKeySource | null } {
  if (config.envApiKey) return { key: config.envApiKey, source: 'env' };
  const stored = repo.getSettings().apiKey?.trim();
  if (stored) return { key: stored, source: 'settings' };
  return { key: null, source: null };
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  source: ApiKeySource;
}

/** Order: env > settings (DB). Never serialise the secret to clients. */
export function resolveGoogleClient(
  config: Pick<Config, 'envGoogleClientId' | 'envGoogleClientSecret'>,
  repo: Pick<Repo, 'getSettings'>,
): GoogleClient | null {
  if (config.envGoogleClientId && config.envGoogleClientSecret) {
    return { clientId: config.envGoogleClientId, clientSecret: config.envGoogleClientSecret, source: 'env' };
  }
  const stored = repo.getSettings().googleClient;
  if (stored?.clientId && stored.clientSecret) return { ...stored, source: 'settings' };
  return null;
}
