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

async function request<R>(method: string, path: string, body?: unknown, opts: { allow404?: boolean } = {}): Promise<R> {
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
      `/api/inbox${qs({ view: q.view, sourceId: q.sourceId, videoId: q.videoId, q: q.q, cursor: q.cursor, limit: q.limit })}`,
    ),
  thread: (id: string, focus?: string) =>
    request<T.ThreadDetail>('GET', `/api/threads/${encodeURIComponent(id)}${qs({ focus })}`),
  triage: (commentIds: string[], to: 'done' | 'replied' | 'inbox') =>
    request<T.TriageResult>('POST', '/api/triage', { commentIds, to }),
  undo: (actionId: number) => request<T.TriageResult>('POST', `/api/triage/${actionId}/undo`),
  getDraft: (commentId: string) =>
    request<DraftDTO | null>('GET', `/api/drafts/${encodeURIComponent(commentId)}`, undefined, { allow404: true }),
  putDraft: (commentId: string, body: string) =>
    request<DraftDTO>('PUT', `/api/drafts/${encodeURIComponent(commentId)}`, { body }),
  deleteDraft: (commentId: string) => request<void>('DELETE', `/api/drafts/${encodeURIComponent(commentId)}`),
  reply: (commentId: string, body: string) =>
    request<T.ReplyResult>('POST', `/api/comments/${encodeURIComponent(commentId)}/reply`, { body }),
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
  settings: () => request<T.SettingsDTO>('GET', '/api/settings'),
  saveSettings: (u: SettingsUpdate) => request<T.SettingsDTO>('PUT', '/api/settings', u),
  addOwnChannel: (input: string, importMode?: T.ImportMode) =>
    request<T.SettingsDTO>('POST', '/api/settings/own-channels', { input, importMode }),
  removeOwnChannel: (channelId: string) =>
    request<T.SettingsDTO>('DELETE', `/api/settings/own-channels/${encodeURIComponent(channelId)}`),
  testKey: (apiKey?: string) => request<{ ok: boolean; message: string }>('POST', '/api/settings/test-key', { apiKey }),
};
