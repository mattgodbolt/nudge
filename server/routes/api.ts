import type { FastifyInstance } from 'fastify';
import type { InboxQuery, SettingsUpdate, SyncRequest } from '../../shared/api.js';
import { parseSourceInput } from '../../shared/youtube-urls.js';
import type { Bootstrap, CommentState, ImportMode, PollTier, TriageResult } from '../../shared/types.js';
import type { AppDeps, StoredSettings } from '../contracts.js';
import { PostError, YtError } from '../contracts.js';
import { isValidClientId, parseGoogleClientJson } from '../reply/google-client.js';
import { setOwnChannelId } from '../sync/own-channels.js';
import { HttpError, asObject, bad, bool, buildSettingsDto, int, notFound, oneOf, str } from './util.js';

const VIEWS = ['inbox', 'done', 'all'] as const;
const IMPORT_MODES = ['none', 'recent', 'all'] as const;
const TIERS = ['hot', 'warm', 'cold', 'frozen', 'paused'] as const;
const THEMES = ['system', 'light', 'dark'] as const;

/** Run a posting action, turning PostError into the HTTP error the client understands. */
async function asHttp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PostError) throw new HttpError(e.status, e.message, e.code);
    throw e;
  }
}

export function registerApiRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo, engine, bus, quota, poster } = deps;

  const emitInbox = (changedIds: string[], addedIds: string[] = []) =>
    bus.emit({ type: 'inbox.changed', counts: repo.counts(), addedIds, changedIds });
  const emitSources = () => bus.emit({ type: 'sources.changed', sources: repo.listSources() });
  const emitSettings = () => bus.emit({ type: 'settings.changed', settings: buildSettingsDto(deps) });
  const emitTriage = (r: TriageResult) => emitInbox(r.changes.map((c) => c.commentId));

  app.get('/api/bootstrap', async (): Promise<Bootstrap> => ({
    settings: buildSettingsDto(deps),
    capabilities: poster.capabilities(),
    counts: repo.counts(),
    sources: repo.listSources(),
    quota: quota.snapshot(),
    sync: engine.status(),
  }));

  app.get('/api/inbox', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const query: InboxQuery = { view: q.view === undefined ? 'inbox' : oneOf(q.view, 'view', VIEWS) };
    if (q.sourceId !== undefined) query.sourceId = int(q.sourceId, 'sourceId', { min: 1 });
    if (q.videoId) query.videoId = q.videoId;
    if (q.q?.trim()) query.q = q.q.trim();
    if (q.cursor) query.cursor = q.cursor;
    query.limit = q.limit === undefined ? 100 : int(q.limit, 'limit', { min: 1, max: 500 });
    return repo.listInbox(query);
  });

  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId', async (req) => {
    const t = repo.getThread(req.params.threadId);
    if (!t) throw notFound('Thread');
    return t;
  });

  /* ---- triage ---- */
  app.post('/api/triage', async (req) => {
    const b = asObject(req.body);
    const ids = b.commentIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000 || !ids.every((i) => typeof i === 'string')) {
      throw bad('"commentIds" must be a non-empty array of strings (max 1000)');
    }
    const to = oneOf(b.to, 'to', ['done', 'replied', 'inbox'] as const) satisfies CommentState;
    const result = repo.triage(ids as string[], to);
    emitTriage(result);
    return result;
  });

  app.post<{ Params: { actionId: string } }>('/api/triage/:actionId/undo', async (req) => {
    const id = int(req.params.actionId, 'actionId', { min: 1 });
    let result: TriageResult;
    try {
      result = repo.undo(id);
    } catch (e) {
      throw new HttpError(409, e instanceof Error ? e.message : 'Cannot undo', 'cannot_undo');
    }
    emitTriage(result);
    return result;
  });

  /* ---- drafts ---- */
  app.get<{ Params: { commentId: string } }>('/api/drafts/:commentId', async (req) => {
    const d = repo.getDraft(req.params.commentId);
    if (!d) throw notFound('Draft');
    return d;
  });
  app.put<{ Params: { commentId: string } }>('/api/drafts/:commentId', async (req) => {
    const body = str(asObject(req.body), 'body', { allowEmpty: true })!;
    if (!repo.getComment(req.params.commentId)) throw notFound('Comment');
    return repo.putDraft(req.params.commentId, body);
  });
  app.delete<{ Params: { commentId: string } }>('/api/drafts/:commentId', async (req, reply) => {
    repo.deleteDraft(req.params.commentId);
    return reply.code(204).send();
  });

  /* ---- reply ---- */
  app.post<{ Params: { id: string } }>('/api/comments/:id/reply', async (req) => {
    const body = str(asObject(req.body), 'body')!;
    const comment = repo.getComment(req.params.id);
    if (!comment) throw notFound('Comment');
    let result: Awaited<ReturnType<typeof poster.reply>>;
    try {
      result = await asHttp(() => poster.reply(comment, body));
    } catch (e) {
      // A failed post can flip capabilities (sign-in revoked, thread not replyable): tell every open tab.
      if (e instanceof HttpError && ['auth_required', 'cannot_reply', 'quota_exhausted'].includes(e.code)) {
        bus.emit({ type: 'capabilities.changed', capabilities: poster.capabilities() });
        emitSettings();
        bus.emit({ type: 'quota.update', quota: quota.snapshot() });
      }
      throw e;
    }
    if (result.mode === 'posted') {
      // The auto-clear may have moved older comments of the thread, so report the whole thread as changed.
      const threadIds = repo.getThread(comment.threadId)?.comments.map((c) => c.id) ?? [comment.id];
      emitInbox([...new Set([comment.id, ...threadIds])], [result.comment.id]);
      bus.emit({ type: 'quota.update', quota: quota.snapshot() });
    } else {
      emitInbox([comment.id]);
    }
    return result;
  });

  /** Delete a reply this app posted (own + app-posted only; enforced by the poster). */
  app.post<{ Params: { id: string } }>('/api/comments/:id/delete', async (req, reply) => {
    const comment = repo.getComment(req.params.id);
    if (!comment) throw notFound('Comment');
    if (!poster.deleteReply)
      throw new HttpError(422, 'Deleting replies needs a connected Google account', 'cannot_reply');
    await asHttp(() => poster.deleteReply!(comment));
    emitInbox([comment.id, comment.threadId]);
    bus.emit({ type: 'quota.update', quota: quota.snapshot() });
    return reply.code(204).send();
  });

  /* ---- sources ---- */
  app.get('/api/sources', async () => repo.listSources());

  app.post('/api/sources/preview', async (req) => {
    const input = str(asObject(req.body), 'input')!;
    const parsed = parseSourceInput(input);
    if (!parsed) throw bad('Could not recognise that as a YouTube video, playlist or channel');
    return parsed;
  });

  app.post('/api/sources', async (req, reply) => {
    const b = asObject(req.body);
    const input = str(b, 'input')!;
    if (!parseSourceInput(input)) throw bad('Could not recognise that as a YouTube video, playlist or channel');
    const importMode = b.importMode === undefined ? undefined : oneOf(b.importMode, 'importMode', IMPORT_MODES);
    const isOwn = bool(b, 'isOwn');
    try {
      const source = await deps.addSource(input, { importMode: importMode as ImportMode | undefined, isOwn });
      emitSources();
      return reply.code(201).send(source);
    } catch (e) {
      if (e instanceof YtError) {
        const status = e.reason === 'notFound' ? 404 : e.reason === 'quotaExceeded' ? 429 : 502;
        throw new HttpError(status, e.message, e.reason);
      }
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/sources/:id', async (req) => {
    const id = int(req.params.id, 'id', { min: 1 });
    if (!repo.getSourceRow(id)) throw notFound('Source');
    const b = asObject(req.body);
    const patch: Parameters<typeof repo.updateSource>[1] = {};
    const enabled = bool(b, 'enabled');
    if (enabled !== undefined) patch.enabled = enabled;
    const isOwn = bool(b, 'isOwn');
    if (isOwn !== undefined) patch.isOwn = isOwn;
    const title = str(b, 'title', { optional: true });
    if (title !== undefined) patch.title = title;
    if (b.importMode !== undefined) patch.importMode = oneOf(b.importMode, 'importMode', IMPORT_MODES);
    if (Object.keys(patch).length === 0) throw bad('No updatable fields supplied');
    const updated = repo.updateSource(id, patch);
    if (isOwn !== undefined && updated.kind === 'channel') {
      if (setOwnChannelId(repo, updated.ytId, isOwn)) emitSettings();
    }
    emitSources();
    return updated;
  });

  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>('/api/sources/:id', async (req, reply) => {
    const id = int(req.params.id, 'id', { min: 1 });
    if (!repo.getSourceRow(id)) throw notFound('Source');
    repo.deleteSource(id, req.query.purge === '1' || req.query.purge === 'true');
    emitSources();
    emitInbox([]);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/sources/:id/videos', async (req) => {
    const id = int(req.params.id, 'id', { min: 1 });
    if (!repo.getSourceRow(id)) throw notFound('Source');
    return repo.listVideos(id);
  });

  app.patch<{ Params: { id: string } }>('/api/videos/:id', async (req) => {
    const b = asObject(req.body);
    if (!('tierOverride' in b)) throw bad('"tierOverride" is required (use null to clear)');
    const tier = b.tierOverride === null ? null : (oneOf(b.tierOverride, 'tierOverride', TIERS) as PollTier);
    if (!repo.getVideoSyncRow(req.params.id)) throw notFound('Video');
    return repo.setVideoTier(req.params.id, tier);
  });

  /* ---- sync + quota ---- */
  app.post('/api/sync', async (req, reply) => {
    const b = req.body === undefined || req.body === null ? {} : asObject(req.body);
    const scope = b.scope === undefined ? 'all' : oneOf(b.scope, 'scope', ['all', 'source', 'video'] as const);
    const syncReq: SyncRequest = { scope };
    if (b.id !== undefined) {
      if (typeof b.id !== 'string' && typeof b.id !== 'number') throw bad('"id" must be a string or number');
      syncReq.id = b.id;
    }
    if (scope !== 'all' && syncReq.id === undefined) throw bad(`"id" is required for scope "${scope}"`);
    const deep = bool(b, 'deep');
    if (deep !== undefined) syncReq.deep = deep;
    if (!quota.canManual()) throw new HttpError(429, 'Daily quota exhausted', 'quota_exhausted');
    // Fire and forget: progress is reported over SSE. The engine merges concurrent requests.
    engine.run({ trigger: 'manual', ...syncReq }).catch((e: unknown) => {
      bus.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    });
    return reply.code(202).send(engine.status());
  });
  app.get('/api/sync/status', async () => engine.status());
  app.get('/api/quota', async () => quota.snapshot());
  app.get('/api/stats', async () => repo.getStats());
  app.post('/api/stats/refresh', async (_req, reply) => {
    if (!deps.backfillDetails) return reply.code(501).send({ error: 'Not available', code: 'unsupported' });
    try {
      await deps.backfillDetails();
    } catch (e) {
      return reply
        .code(502)
        .send({ error: e instanceof Error ? e.message : 'Could not fetch video details', code: 'refresh_failed' });
    }
    return repo.getStats();
  });

  /* ---- settings ---- */
  app.get('/api/settings', async () => buildSettingsDto(deps));

  app.put('/api/settings', async (req) => {
    const b = asObject(req.body);
    const u: SettingsUpdate = {};
    if (b.apiKey !== undefined) {
      if (b.apiKey !== null && typeof b.apiKey !== 'string') throw bad('"apiKey" must be a string or null');
      u.apiKey = b.apiKey;
    }
    if (b.ownChannelIds !== undefined) {
      const ids = b.ownChannelIds;
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string' && /^UC[\w-]{22}$/.test(i))) {
        throw bad('"ownChannelIds" must be an array of channel ids (UC + 22 characters)');
      }
      u.ownChannelIds = [...new Set(ids as string[])];
    }
    const pollEnabled = bool(b, 'pollEnabled');
    if (pollEnabled !== undefined) u.pollEnabled = pollEnabled;
    if (b.dailyQuotaBudget !== undefined)
      u.dailyQuotaBudget = int(b.dailyQuotaBudget, 'dailyQuotaBudget', { min: 0, max: 1_000_000 });
    if (b.manualReserve !== undefined)
      u.manualReserve = int(b.manualReserve, 'manualReserve', { min: 0, max: 1_000_000 });
    if (b.backfillDays !== undefined) u.backfillDays = int(b.backfillDays, 'backfillDays', { min: 0, max: 36500 });
    if (b.theme !== undefined) u.theme = oneOf(b.theme, 'theme', THEMES);
    const googleClient = b.googleClient === undefined ? undefined : parseGoogleClientUpdate(b.googleClient);

    const before = repo.getSettings();
    const { apiKey, googleClient: _ignored, ...rest } = u;
    const patch: Parameters<typeof repo.updateSettings>[0] = { ...rest };
    if (googleClient !== undefined) patch.googleClient = googleClient;
    if (apiKey !== undefined) patch.apiKey = apiKey?.trim() ? apiKey.trim() : null;
    repo.updateSettings(patch);

    const after = repo.getSettings();
    const ownChanged =
      JSON.stringify([...before.ownChannelIds].sort()) !== JSON.stringify([...after.ownChannelIds].sort());
    if (ownChanged) {
      repo.recomputeOwnership(after.ownChannelIds);
      // Keep the channel sources' "mine" flag in step with the registered ids.
      for (const src of repo.listSources()) {
        if (src.kind === 'channel' && src.isOwn !== after.ownChannelIds.includes(src.ytId)) {
          repo.updateSource(src.id, { isOwn: !src.isOwn });
        }
      }
      emitSources();
      emitInbox([]);
    }
    deps.onSettingsChanged();
    const dto = buildSettingsDto(deps);
    bus.emit({ type: 'settings.changed', settings: dto });
    bus.emit({ type: 'quota.update', quota: quota.snapshot() });
    if (googleClient !== undefined) bus.emit({ type: 'capabilities.changed', capabilities: poster.capabilities() });
    return dto;
  });

  /** Resolve whatever the user pasted (URL, @handle, UC id) into their channel, track it and register it as mine. */
  app.post('/api/settings/own-channels', async (req) => {
    const b = asObject(req.body);
    const input = str(b, 'input')!;
    const importMode = b.importMode === undefined ? 'recent' : oneOf(b.importMode, 'importMode', IMPORT_MODES);
    if (parseSourceInput(input)?.kind !== 'channel') {
      throw bad('Paste your channel URL (youtube.com/@handle or /channel/UC...), an @handle or a channel id');
    }
    try {
      const source = await deps.addSource(input, { importMode, isOwn: true });
      setOwnChannelId(repo, source.ytId, true);
    } catch (e) {
      if (e instanceof YtError) {
        const status = e.reason === 'notFound' ? 404 : e.reason === 'quotaExceeded' ? 429 : 502;
        throw new HttpError(status, e.message, e.reason);
      }
      throw e;
    }
    emitSources();
    emitInbox([]);
    const dto = buildSettingsDto(deps);
    bus.emit({ type: 'settings.changed', settings: dto });
    return dto;
  });

  app.delete<{ Params: { channelId: string } }>('/api/settings/own-channels/:channelId', async (req) => {
    const id = req.params.channelId;
    setOwnChannelId(repo, id, false);
    for (const src of repo.listSources()) {
      if (src.kind === 'channel' && src.ytId === id && src.isOwn) repo.updateSource(src.id, { isOwn: false });
    }
    emitSources();
    emitInbox([]);
    const dto = buildSettingsDto(deps);
    bus.emit({ type: 'settings.changed', settings: dto });
    return dto;
  });

  app.post('/api/settings/test-key', async (req) => {
    const b = req.body === undefined || req.body === null ? {} : asObject(req.body);
    const supplied = str(b, 'apiKey', { optional: true })?.trim();
    const key = supplied || deps.resolveApiKey().key;
    if (!key) return { ok: false, message: 'No API key configured' };
    return deps.testKey(key);
  });

  /* ---- demo ---- */
  if (deps.demo && deps.demoTick) {
    const tick = deps.demoTick;
    app.post('/api/demo/tick', async (_req, reply) => {
      tick();
      return reply.code(204).send();
    });
  }
}

/** Accepts {json}, {clientId, clientSecret} or null (remove). Never echoes the secret in an error. */
function parseGoogleClientUpdate(v: unknown): StoredSettings['googleClient'] {
  if (v === null) return null;
  const o = asObject(v);
  if (typeof o.json === 'string') {
    const parsed = parseGoogleClientJson(o.json);
    if (!parsed) {
      throw bad('Could not find a valid client_id (…apps.googleusercontent.com) and client_secret in that JSON');
    }
    return parsed;
  }
  const clientId = str(o, 'clientId')!.trim();
  const clientSecret = str(o, 'clientSecret')!.trim();
  if (!isValidClientId(clientId)) throw bad('"clientId" must end with .apps.googleusercontent.com');
  return { clientId, clientSecret };
}
