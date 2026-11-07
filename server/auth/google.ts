import { createHash, randomBytes } from 'node:crypto';
import type { GoogleAuthDTO } from '../../shared/types.js';
import { PostError, type GoogleAccountRow, type GoogleAuth, type PostGateway, type Repo } from '../contracts.js';
import type { GoogleClient } from '../config.js';
import { setOwnChannelId } from '../sync/own-channels.js';
import type { AddSource } from '../sync/sources.js';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 5;
const REFRESH_MARGIN_MS = 60_000;
const HTTP_TIMEOUT_MS = 15_000;

export interface GoogleAuthOptions {
  repo: Repo;
  gateway: Pick<PostGateway, 'myChannel'>;
  getClient: () => GoogleClient | null;
  /** Evaluated lazily: the listening port is only known after listen(). */
  redirectUri: () => string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  /** Fired whenever accounts / needs_reauth change, so the server can emit capabilities + settings events. */
  onChange?: () => void;
  /** Used to start tracking the connected channel when the user had no own channel yet. */
  addSource?: AddSource;
  /** Charges the channels.list call made during connect. */
  quota?: { charge(endpoint: string, units: number): void };
}

interface Pending {
  verifier: string;
  returnOrigin: string;
  createdAt: number;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function createGoogleAuth(opts: GoogleAuthOptions): GoogleAuth {
  const { repo, gateway } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.clock ?? (() => new Date());
  const changed = () => opts.onChange?.();
  const pending = new Map<string, Pending>();
  const refreshing = new Map<string, Promise<string>>();

  const prune = () => {
    const t = now().getTime();
    for (const [k, v] of pending) if (t - v.createdAt > STATE_TTL_MS) pending.delete(k);
  };

  const postForm = async (url: string, form: Record<string, string>) => {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // non-JSON body: leave empty
    }
    return { ok: res.ok, status: res.status, json };
  };

  const accounts = () => repo.listGoogleAccounts();
  const usable = () => accounts().filter((a) => !a.needsReauth);

  function pickAccount(videoChannelId: string | null): GoogleAccountRow | null {
    const ok = usable();
    return (
      (videoChannelId ? ok.find((a) => a.channelId === videoChannelId) : undefined) ??
      ok.find((a) => a.isDefault) ??
      ok[0] ??
      null
    );
  }

  async function refresh(acct: GoogleAccountRow): Promise<string> {
    const client = opts.getClient();
    if (!client) throw new PostError('no_client', 'No Google OAuth client is configured', 400);
    let r;
    try {
      r = await postForm(TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: acct.refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      });
    } catch (e) {
      throw new PostError(
        'post_failed',
        `Could not reach Google to refresh sign-in: ${(e as Error).message}`,
        502,
        true,
      );
    }
    if (r.status === 400 || r.status === 401) {
      const why = String(r.json.error_description ?? r.json.error ?? 'invalid_grant');
      repo.updateGoogleAccount(acct.channelId, {
        needsReauth: true,
        lastError: why,
        accessToken: null,
        accessExpiresAt: null,
      });
      changed();
      throw new PostError('auth_required', 'Google sign-in expired or was revoked; reconnect in Settings', 401);
    }
    const token = r.json.access_token;
    if (!r.ok || typeof token !== 'string') {
      throw new PostError('post_failed', `Google token refresh failed (HTTP ${r.status})`, 502, true);
    }
    const expiresIn = Number(r.json.expires_in) || 3600;
    repo.updateGoogleAccount(acct.channelId, {
      accessToken: token,
      accessExpiresAt: new Date(now().getTime() + expiresIn * 1000).toISOString(),
      lastError: null,
    });
    return token;
  }

  const fail = (result: string, returnOrigin: string | null) => ({
    result,
    returnTo: `${returnOrigin ?? ''}/settings?google=${result}`,
  });

  return {
    status(): GoogleAuthDTO {
      const client = opts.getClient();
      return {
        clientConfigured: client !== null,
        clientSource: client?.source ?? null,
        redirectUri: opts.redirectUri(),
        accounts: accounts().map((a) => ({
          channelId: a.channelId,
          title: a.title,
          thumbnailUrl: a.thumbnailUrl,
          connectedAt: a.connectedAt,
          needsReauth: a.needsReauth,
          lastError: a.lastError,
          isDefault: a.isDefault,
        })),
      };
    },

    start(returnOrigin) {
      const client = opts.getClient();
      if (!client) throw new PostError('no_client', 'No Google OAuth client is configured', 400);
      prune();
      // Oldest entries go first; Map preserves insertion order.
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
      const state = b64url(randomBytes(32));
      const verifier = b64url(randomBytes(48));
      pending.set(state, { verifier, returnOrigin, createdAt: now().getTime() });
      const q = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: opts.redirectUri(),
        response_type: 'code',
        scope: SCOPE,
        state,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent select_account',
      });
      return { url: `${AUTH_URL}?${q.toString()}` };
    },

    async handleCallback(q) {
      prune();
      const entry = q.state ? pending.get(q.state) : undefined;
      if (!entry) return fail('bad_state', null); // relative: stays on whichever host received the callback
      pending.delete(q.state!); // single use
      const origin = entry.returnOrigin;
      if (q.error) return fail('denied', origin);
      if (!q.code) return fail('token_exchange_failed', origin);
      const client = opts.getClient();
      if (!client) return fail('token_exchange_failed', origin);

      let tok;
      try {
        tok = await postForm(TOKEN_URL, {
          grant_type: 'authorization_code',
          code: q.code,
          code_verifier: entry.verifier,
          redirect_uri: opts.redirectUri(),
          client_id: client.clientId,
          client_secret: client.clientSecret,
        });
      } catch {
        return fail('token_exchange_failed', origin);
      }
      const access = tok.json.access_token;
      const refreshToken = tok.json.refresh_token;
      if (!tok.ok || typeof access !== 'string' || typeof refreshToken !== 'string') {
        return fail('token_exchange_failed', origin);
      }
      const scope = typeof tok.json.scope === 'string' ? tok.json.scope : '';
      if (!scope.split(/\s+/).includes(SCOPE)) return fail('scope_missing', origin);

      let channel;
      try {
        opts.quota?.charge('channels.list', 1);
        channel = await gateway.myChannel(access);
      } catch {
        return fail('token_exchange_failed', origin);
      }
      if (!channel) return fail('no_channel', origin);

      const existing = accounts();
      repo.upsertGoogleAccount({
        channelId: channel.id,
        title: channel.title,
        thumbnailUrl: channel.thumbnailUrl,
        refreshToken,
        accessToken: access,
        accessExpiresAt: new Date(now().getTime() + (Number(tok.json.expires_in) || 3600) * 1000).toISOString(),
        scope,
        connectedAt: now().toISOString(),
        needsReauth: false,
        lastError: null,
        isDefault: existing.find((a) => a.channelId === channel.id)?.isDefault ?? existing.length === 0,
      });
      if (!accounts().some((a) => a.isDefault)) repo.setDefaultGoogleAccount(channel.id);

      // The connected channel is "me": otherwise our own replies would arrive as inbox items.
      const hadOwn = repo.getSettings().ownChannelIds.length > 0;
      setOwnChannelId(repo, channel.id, true);
      if (!hadOwn && opts.addSource) {
        try {
          await opts.addSource(channel.id, { isOwn: true, importMode: 'recent' });
        } catch (e) {
          // Connecting succeeded; tracking can be added manually (e.g. no API key yet).
          console.warn('could not start tracking connected channel:', (e as Error).message);
        }
      }
      changed();
      return { result: 'connected', returnTo: `${origin}/settings?google=connected` };
    },

    async getAccessToken(channelId) {
      const acct = channelId ? accounts().find((a) => a.channelId === channelId) : pickAccount(null);
      if (!acct || acct.needsReauth) {
        throw new PostError('auth_required', 'Not signed in to Google; connect an account in Settings', 401);
      }
      const exp = acct.accessExpiresAt ? Date.parse(acct.accessExpiresAt) : 0;
      if (acct.accessToken && exp - now().getTime() > REFRESH_MARGIN_MS) {
        return { token: acct.accessToken, channelId: acct.channelId };
      }
      let p = refreshing.get(acct.channelId);
      if (!p) {
        p = refresh(acct).finally(() => refreshing.delete(acct.channelId));
        refreshing.set(acct.channelId, p);
      }
      return { token: await p, channelId: acct.channelId };
    },

    async disconnect(channelId) {
      const acct = channelId ? accounts().find((a) => a.channelId === channelId) : (pickAccount(null) ?? accounts()[0]);
      if (!acct) return;
      try {
        await doFetch(`${REVOKE_URL}?token=${encodeURIComponent(acct.refreshToken)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch {
        // best effort: the local token is deleted regardless
      }
      repo.deleteGoogleAccount(acct.channelId);
      const rest = accounts();
      if (rest.length && !rest.some((a) => a.isDefault)) repo.setDefaultGoogleAccount(rest[0]!.channelId);
      changed();
    },

    setDefault(channelId) {
      if (!accounts().some((a) => a.channelId === channelId)) {
        throw new PostError('auth_required', 'Unknown Google account', 404);
      }
      repo.setDefaultGoogleAccount(channelId);
      changed();
    },

    canPost: () => opts.getClient() !== null && usable().length > 0,
    pickAccount,
  };
}
