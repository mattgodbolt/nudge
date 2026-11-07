import { GatewayError, type PostGateway, type YtComment } from '../contracts.js';
import { normComment } from '../youtube/client.js';

const API = 'https://www.googleapis.com/youtube/v3';
const TIMEOUT_MS = 15_000;

interface GoogleErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string }[]; status?: string };
}

/**
 * OAuth-authorised YouTube calls with plain fetch. No `key` parameter: the Bearer token identifies the caller.
 * Every failure is a GatewayError; `network: true` means the request may not have completed (timeout, connection error).
 */
export function createHttpPostGateway(opts: { fetchImpl?: typeof fetch } = {}): PostGateway {
  const doFetch = opts.fetchImpl ?? fetch;

  async function call(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      // Keep the Node error code (ECONNREFUSED, ENOTFOUND) reachable: the poster uses it to tell "never sent" apart.
      const cause = (e as { cause?: { code?: string } }).cause;
      const err = new GatewayError(
        timedOut ? 'Request to YouTube timed out' : `Network error: ${e instanceof Error ? e.message : String(e)}`,
        0,
        timedOut ? 'timeout' : (cause?.code ?? 'network'),
        true,
      );
      throw err;
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
    }
    if (!res.ok) {
      const err = (json as GoogleErrorBody | null)?.error;
      throw new GatewayError(err?.message ?? `HTTP ${res.status}`, res.status, err?.errors?.[0]?.reason ?? null);
    }
    return json;
  }

  return {
    async insertReply(token, p): Promise<YtComment> {
      const raw = await call(token, 'POST', '/comments?part=snippet', {
        snippet: { parentId: p.parentId, textOriginal: p.text },
      });
      if (!raw || typeof raw !== 'object' || typeof (raw as { id?: unknown }).id !== 'string') {
        throw new GatewayError('Unexpected response from comments.insert', 502, null);
      }
      return normComment(raw as Parameters<typeof normComment>[0], p.videoId, p.parentId);
    },

    async listReplies(token, parentId, videoId) {
      const q = new URLSearchParams({ part: 'snippet', parentId, maxResults: '20', textFormat: 'html' });
      const raw = (await call(token, 'GET', `/comments?${q}`)) as {
        items?: Parameters<typeof normComment>[0][];
      } | null;
      return (raw?.items ?? []).map((c) => normComment(c, videoId, parentId));
    },

    async deleteComment(token, commentId) {
      await call(token, 'DELETE', `/comments?${new URLSearchParams({ id: commentId })}`);
    },

    async myChannel(token) {
      const raw = (await call(token, 'GET', '/channels?part=snippet&mine=true')) as {
        items?: { id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> } }[];
      } | null;
      const c = raw?.items?.[0];
      if (!c) return null;
      const t = c.snippet?.thumbnails;
      return {
        id: c.id,
        title: c.snippet?.title ?? c.id,
        thumbnailUrl: t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? null,
      };
    },
  };
}
