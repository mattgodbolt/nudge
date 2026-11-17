import type { FastifyInstance } from 'fastify';
import type { AppDeps, SyncEngine } from '../contracts.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';

/** Headers that pass the local-origin guard: the CSRF marker and a loopback Host. */
export const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };

/**
 * The AppDeps every route test needs, with inert stand-ins for everything it does not exercise. `parts` supplies
 * the pieces that vary per test (bus and quota usually come from makeEnv) and any optional deps under test;
 * whatever it sets replaces the default of the same name.
 */
export function testDeps(repo: AppDeps['repo'], parts: Pick<AppDeps, 'bus' | 'quota'> & Partial<AppDeps>): AppDeps {
  return {
    repo,
    engine: { run: async () => ({}), status: () => ({}) } as unknown as SyncEngine,
    poster: createHandoffPoster(repo),
    auth: fakeGoogleAuth(),
    addSource: async () => {
      throw new Error('unused');
    },
    testKey: async () => ({ ok: true, message: '' }),
    onSettingsChanged: () => {},
    resolveApiKey: () => ({ key: 'k', source: 'env' }),
    demo: false,
    ...parts,
  };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** `app` is a getter because tests rebuild it in beforeEach. */
export const sender =
  (app: () => FastifyInstance) =>
  (method: Method, url: string, payload?: unknown, headers: Record<string, string> = H) =>
    app().inject({ method, url, headers, payload: payload as never });
