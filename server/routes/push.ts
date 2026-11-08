import type { FastifyInstance } from 'fastify';
import type { PushConfigDTO, PushPrefs, PushStateDTO } from '../../shared/types.js';
import type { AppDeps } from '../contracts.js';
import { isAllowedPushEndpoint } from '../push/sender.js';
import { HttpError, asObject, bad, bool, str } from './util.js';

const DEFAULT_PREFS: PushPrefs = { newComments: true, snoozeWake: true };
const MAX_KEY_LEN = 256;
const MAX_ENDPOINT_LEN = 2048;

function endpointOf(body: unknown): string {
  const endpoint = str(asObject(body), 'endpoint')!;
  if (endpoint.length > MAX_ENDPOINT_LEN || !isAllowedPushEndpoint(endpoint)) {
    throw bad('Unrecognised push service endpoint');
  }
  return endpoint;
}

export function registerPushRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo } = deps;
  const service = () => {
    if (!deps.push) throw new HttpError(503, 'Push notifications are not available', 'push_unavailable');
    return deps.push;
  };
  const stateOf = (endpoint: string): PushStateDTO => {
    const s = repo.getPushSubscription(endpoint);
    return s
      ? { subscribed: true, prefs: { newComments: s.newComments, snoozeWake: s.snoozeWake } }
      : { subscribed: false, prefs: DEFAULT_PREFS };
  };

  app.get('/api/push/config', async (): Promise<PushConfigDTO> => ({ publicKey: service().publicKey() }));

  app.post('/api/push/state', async (req): Promise<PushStateDTO> => {
    service();
    return stateOf(endpointOf(req.body));
  });

  /** Register (or update the preferences of) this device. Re-sending the same subscription is the update path. */
  app.post('/api/push/subscribe', async (req): Promise<PushStateDTO> => {
    service();
    const b = asObject(req.body);
    const sub = asObject(b.subscription);
    const endpoint = endpointOf(sub);
    const keys = asObject(sub.keys);
    const p256dh = str(keys, 'p256dh')!;
    const auth = str(keys, 'auth')!;
    if (p256dh.length > MAX_KEY_LEN || auth.length > MAX_KEY_LEN) throw bad('Invalid subscription keys');
    const prefsIn = b.prefs === undefined ? {} : asObject(b.prefs);
    const existing = repo.getPushSubscription(endpoint);
    const base = existing ?? DEFAULT_PREFS;
    const prefs: PushPrefs = {
      newComments: bool(prefsIn, 'newComments') ?? base.newComments,
      snoozeWake: bool(prefsIn, 'snoozeWake') ?? base.snoozeWake,
    };
    const label = str(b, 'label', { optional: true })?.slice(0, 80) ?? existing?.label ?? null;
    repo.upsertPushSubscription({ endpoint, p256dh, auth, label, prefs });
    return stateOf(endpoint);
  });

  app.post('/api/push/unsubscribe', async (req, reply) => {
    service();
    repo.deletePushSubscription(endpointOf(req.body));
    return reply.code(204).send();
  });

  app.post('/api/push/test', async (req) => {
    const result = await service().test(endpointOf(req.body));
    if (result === 'unknown') throw new HttpError(404, 'This device is not subscribed', 'not_subscribed');
    return { result };
  });
}
