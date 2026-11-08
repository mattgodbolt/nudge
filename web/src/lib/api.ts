import type * as T from '../../../shared/types';
import type { DraftDTO, InboxPage, InboxQuery, SettingsUpdate, SyncRequest } from '../../../shared/api';
import { CLIENT_HEADER } from '../../../shared/api';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * Waits between retries of a read. The server restarts for an auto-update in 10-20 seconds, during which the proxy
 * answers 502 (or the connection drops); reads ride that out quietly instead of surfacing an error. Tests shorten it.
 */
export const retry = { delaysMs: [1000, 2000, 4000, 8000] };
const TRANSIENT = new Set([0, 502, 503, 504]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function request<R>(method: string, path: string, body?: unknown, opts: { allow404?: boolean } = {}): Promise<R> {
  // Only reads are retried: repeating a write that may have reached the server could do it twice.
  const delays = method === 'GET' ? retry.delaysMs : [];
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce<R>(method, path, body, opts);
    } catch (e) {
      if (!(e instanceof ApiRequestError) || !TRANSIENT.has(e.status) || attempt >= delays.length) throw e;
      await sleep(delays[attempt] ?? 0);
    }
  }
}

async function requestOnce<R>(
  method: string,
  path: string,
  body?: unknown,
  opts: { allow404?: boolean } = {},
): Promise<R> {
  const headers: Record<string, string> = { [CLIENT_HEADER]: '1' };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch (e) {
    throw new ApiRequestError(e instanceof Error ? e.message : 'Network error', 0, 'network');
  }
  if (res.status === 204) return undefined as R;
  if (res.status === 404 && opts.allow404) return null as R;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const err = data as Partial<T.ApiError> | undefined;
    throw new ApiRequestError(err?.error ?? `${res.status} ${res.statusText}`, res.status, err?.code ?? 'http');
  }
  return data as R;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const api = {
  bootstrap: () => request<T.Bootstrap>('GET', '/api/bootstrap'),
  inbox: (q: InboxQuery) =>
    request<InboxPage>(
      'GET',
      `/api/inbox${qs({ view: q.view, sourceId: q.sourceId, videoId: q.videoId, labelId: q.labelId, feedId: q.feedId, repo: q.repo, order: q.order, kind: q.kind, audience: q.audience, q: q.q, cursor: q.cursor, limit: q.limit })}`,
    ),
  thread: (id: string, focus?: string) =>
    request<T.ThreadDetail>('GET', `/api/threads/${encodeURIComponent(id)}${qs({ focus })}`),
  triage: (commentIds: string[], to: 'done' | 'replied' | 'inbox') =>
    request<T.TriageResult>('POST', '/api/triage', { commentIds, to }),
  undo: (actionId: number) => request<T.TriageResult>('POST', `/api/triage/${actionId}/undo`),
  snooze: (commentIds: string[], until: string | null) =>
    request<T.SnoozeResult>('POST', '/api/snooze', { commentIds, until }),
  undoSnooze: (actionId: number) => request<T.SnoozeResult>('POST', `/api/snooze/${actionId}/undo`),
  labels: () => request<T.LabelDTO[]>('GET', '/api/labels'),
  createLabel: (name: string, color?: T.LabelColor) => request<T.LabelDTO>('POST', '/api/labels', { name, color }),
  patchLabel: (id: number, patch: Partial<Pick<T.LabelDTO, 'name' | 'color' | 'position'>>) =>
    request<T.LabelDTO>('PATCH', `/api/labels/${id}`, patch),
  deleteLabel: (id: number) => request<void>('DELETE', `/api/labels/${id}`),
  applyLabels: (commentIds: string[], add: number[], remove: number[]) =>
    request<T.LabelApplyResult>('POST', '/api/labels/apply', { commentIds, add, remove }),
  getDraft: (commentId: string) =>
    request<DraftDTO | null>('GET', `/api/drafts/${encodeURIComponent(commentId)}`, undefined, { allow404: true }),
  putDraft: (commentId: string, body: string) =>
    request<DraftDTO>('PUT', `/api/drafts/${encodeURIComponent(commentId)}`, { body }),
  deleteDraft: (commentId: string) => request<void>('DELETE', `/api/drafts/${encodeURIComponent(commentId)}`),
  reply: (commentId: string, body: string) =>
    request<T.ReplyResult>('POST', `/api/comments/${encodeURIComponent(commentId)}/reply`, { body }),
  deleteReply: (commentId: string) => request<void>('POST', `/api/comments/${encodeURIComponent(commentId)}/delete`),
  authStatus: () => request<T.GoogleAuthDTO>('GET', '/api/auth/status'),
  authStart: () => request<{ url: string }>('POST', '/api/auth/start', {}),
  authLogout: (channelId?: string) => request<T.GoogleAuthDTO>('POST', '/api/auth/logout', { channelId }),
  authDefault: (channelId: string) => request<T.GoogleAuthDTO>('POST', '/api/auth/default', { channelId }),
  sources: () => request<T.SourceDTO[]>('GET', '/api/sources'),
  addSource: (input: string, opts: { importMode?: T.ImportMode; isOwn?: boolean } = {}) =>
    request<T.SourceDTO>('POST', '/api/sources', { input, ...opts }),
  patchSource: (id: number, patch: Partial<Pick<T.SourceDTO, 'enabled' | 'isOwn' | 'title' | 'importMode'>>) =>
    request<T.SourceDTO>('PATCH', `/api/sources/${id}`, patch),
  deleteSource: (id: number, purge = false) => request<void>('DELETE', `/api/sources/${id}${purge ? '?purge=1' : ''}`),
  sourceVideos: (id: number) => request<T.VideoDTO[]>('GET', `/api/sources/${id}/videos`),
  patchVideo: (id: string, tierOverride: T.PollTier | null) =>
    request<T.VideoDTO>('PATCH', `/api/videos/${encodeURIComponent(id)}`, { tierOverride }),
  sync: (req: SyncRequest) => request<T.SyncStatus>('POST', '/api/sync', req),
  syncStatus: () => request<T.SyncStatus>('GET', '/api/sync/status'),
  quota: () => request<T.QuotaDTO>('GET', '/api/quota'),
  stats: () => request<T.StatsDTO>('GET', '/api/stats'),
  refreshStats: () => request<T.StatsDTO>('POST', '/api/stats/refresh', {}),
  settings: () => request<T.SettingsDTO>('GET', '/api/settings'),
  saveSettings: (u: SettingsUpdate) => request<T.SettingsDTO>('PUT', '/api/settings', u),
  addOwnChannel: (input: string, importMode?: T.ImportMode) =>
    request<T.SettingsDTO>('POST', '/api/settings/own-channels', { input, importMode }),
  removeOwnChannel: (channelId: string) =>
    request<T.SettingsDTO>('DELETE', `/api/settings/own-channels/${encodeURIComponent(channelId)}`),
  pushConfig: () => request<T.PushConfigDTO>('GET', '/api/push/config'),
  pushState: (endpoint: string) => request<T.PushStateDTO>('POST', '/api/push/state', { endpoint }),
  pushSubscribe: (subscription: T.PushSubscriptionInput, prefs?: Partial<T.PushPrefs>, label?: string) =>
    request<T.PushStateDTO>('POST', '/api/push/subscribe', { subscription, prefs, label }),
  pushUnsubscribe: (endpoint: string) => request<void>('POST', '/api/push/unsubscribe', { endpoint }),
  pushTest: (endpoint: string) => request<{ result: 'ok' | 'gone' | 'error' }>('POST', '/api/push/test', { endpoint }),
  feeds: () => request<{ feeds: T.FeedDTO[]; mutes: T.MuteRuleDTO[] }>('GET', '/api/feeds'),
  addFeed: (f: { owner: string; prs?: boolean; issues?: boolean; importMode?: T.ImportMode }) =>
    request<T.FeedDTO>('POST', '/api/feeds', f),
  patchFeed: (id: number, p: Partial<Pick<T.FeedDTO, 'enabled' | 'prs' | 'issues'>>) =>
    request<T.FeedDTO>('PATCH', `/api/feeds/${id}`, p),
  deleteFeed: (id: number) => request<void>('DELETE', `/api/feeds/${id}`),
  pollFeed: (id: number) => request<T.FeedDTO>('POST', `/api/feeds/${id}/poll`),
  addMute: (kind: T.MuteKind, value?: string) =>
    request<{ rule: T.MuteRuleDTO; triage: T.TriageResult | null }>('POST', '/api/mutes', { kind, value }),
  deleteMute: (id: number) => request<void>('DELETE', `/api/mutes/${id}`),
  testGithub: (token?: string) =>
    request<{ ok: boolean; message: string; login?: string }>('POST', '/api/settings/test-github', { token }),
  assistant: (body: { text: string; now: string; selectedId: string | null }) =>
    request<T.AssistantResponse>('POST', '/api/assistant', body),
  deleteTodo: (id: string) => request<void>('DELETE', `/api/todos/${encodeURIComponent(id)}`),
  testLlm: (apiKey?: string) => request<{ ok: boolean; message: string }>('POST', '/api/settings/test-llm', { apiKey }),
  testKey: (apiKey?: string) => request<{ ok: boolean; message: string }>('POST', '/api/settings/test-key', { apiKey }),
};
