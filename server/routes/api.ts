import type { FastifyInstance } from 'fastify';
import type { InboxQuery, SettingsUpdate, SyncRequest } from '../../shared/api.js';
import { parseSourceInput } from '../../shared/youtube-urls.js';
import type { Bootstrap, CommentState, ImportMode, PollTier, SnoozeResult, TriageResult } from '../../shared/types.js';
import type { AppDeps, StoredSettings } from '../contracts.js';
import { LabelError, PostError, YtError } from '../contracts.js';
import { LABEL_COLORS, MAX_LABELS } from '../../shared/types.js';
import { isValidClientId, parseGoogleClientJson } from '../reply/google-client.js';
import { setOwnChannelId } from '../sync/own-channels.js';
import { LOGIN } from './github.js';
import { HttpError, asObject, bad, bool, buildSettingsDto, int, notFound, oneOf, str } from './util.js';

const VIEWS = ['inbox', 'done', 'all', 'snoozed'] as const;
const MIN_SNOOZE_MS = 30_000;
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;
const LABEL_STATUS = { duplicate_label: 409, too_many_labels: 409, bad_name: 400, not_found: 404 } as const;
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

/** Run a label operation, turning LabelError into the HTTP error the client understands. */
function asLabelHttp<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LabelError) throw new HttpError(LABEL_STATUS[e.code], e.message, e.code);
    throw e;
  }
}

/** Validate the GitHub part of a settings update. A token is opaque; logins must look like GitHub logins. */
function parseGithubUpdate(v: unknown): NonNullable<SettingsUpdate['github']> {
  const g = asObject(v);
  const out: NonNullable<SettingsUpdate['github']> = {};
  if (g.token !== undefined) {
    if (g.token !== null && (typeof g.token !== 'string' || g.token.length > 300 || /\s/.test(g.token.trim()))) {
      throw bad('"github.token" must be a token string or null');
    }
    out.token = g.token as string | null;
  }
  if (g.myAccounts !== undefined) {
    const a = g.myAccounts;
    if (!Array.isArray(a) || a.length > 20 || !a.every((l) => typeof l === 'string' && LOGIN.test(l.trim()))) {
      throw bad('"github.myAccounts" must be a list of GitHub logins');
    }
    out.myAccounts = [...new Set((a as string[]).map((l) => l.trim()))];
  }
  return out;
}

/** The assistant's settings: an opaque key (null removes it) and a model id. */
function parseLlmUpdate(v: unknown): NonNullable<SettingsUpdate['llm']> {
  const g = asObject(v);
  const out: NonNullable<SettingsUpdate['llm']> = {};
  if (g.apiKey !== undefined) {
    if (g.apiKey !== null && (typeof g.apiKey !== 'string' || g.apiKey.length > 300 || /\s/.test(g.apiKey.trim()))) {
      throw bad('"llm.apiKey" must be a key string or null');
    }
    out.apiKey = g.apiKey as string | null;
  }
  if (g.model !== undefined) {
    if (typeof g.model !== 'string' || !/^[\w.:-]{3,80}$/.test(g.model.trim()))
      throw bad('"llm.model" must be a model id');
    out.model = g.model.trim();
  }
  return out;
}

function idList(v: unknown, name: string, max: number): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max || !v.every((i) => typeof i === 'string')) {
    throw bad(`"${name}" must be a non-empty array of strings (max ${max})`);
  }
  return v as string[];
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
    labels: repo.listLabels(),
    sources: repo.listSources(),
    quota: quota.snapshot(),
    sync: engine.status(),
    feeds: repo.listFeeds(),
    mutes: repo.listMuteRules(),
  }));

  app.get('/api/inbox', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const query: InboxQuery = { view: q.view === undefined ? 'inbox' : oneOf(q.view, 'view', VIEWS) };
    if (q.sourceId !== undefined) query.sourceId = int(q.sourceId, 'sourceId', { min: 1 });
    if (q.videoId) query.videoId = q.videoId;
    if (q.labelId !== undefined) query.labelId = int(q.labelId, 'labelId', { min: 1 });
    if (q.feedId !== undefined) query.feedId = int(q.feedId, 'feedId', { min: 1 });
    if (q.repo) {
      if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(q.repo)) throw bad('"repo" must look like owner/name');
      query.repo = q.repo;
    }
    if (q.kind) query.kind = oneOf(q.kind, 'kind', ['pr', 'issue', 'todo'] as const);
    if (q.audience) {
      query.audience = oneOf(q.audience, 'audience', ['outside', 'team', 'contributors', 'bots', 'people'] as const);
    }
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

  /* ---- snooze ---- */
  const emitSnooze = (r: SnoozeResult) => emitInbox(r.changes.map((c) => c.commentId));

  app.post('/api/snooze', async (req) => {
    const b = asObject(req.body);
    const ids = idList(b.commentIds, 'commentIds', 500);
    let until: string | null = null;
    if (b.until !== null) {
      const t = typeof b.until === 'string' ? new Date(b.until).getTime() : NaN;
      const delta = t - Date.now();
      if (Number.isNaN(t) || delta < MIN_SNOOZE_MS || delta > MAX_SNOOZE_MS) {
        throw new HttpError(
          400,
          '"until" must be null or an ISO time between 30 seconds and a year from now',
          'bad_until',
        );
      }
      until = new Date(t).toISOString();
    }
    const result = repo.snooze(ids, until);
    emitSnooze(result);
    return result;
  });

  app.post<{ Params: { actionId: string } }>('/api/snooze/:actionId/undo', async (req) => {
    const id = int(req.params.actionId, 'actionId', { min: 1 });
    let result: SnoozeResult;
    try {
      result = repo.undoSnooze(id);
    } catch (e) {
      throw new HttpError(409, e instanceof Error ? e.message : 'Cannot undo', 'cannot_undo');
    }
    emitSnooze(result);
    return result;
  });

  /* ---- labels ---- */
  const emitLabels = () => bus.emit({ type: 'labels.changed', labels: repo.listLabels() });
  const colorOf = (v: unknown) => (v === undefined ? undefined : oneOf(v, 'color', LABEL_COLORS));

  app.get('/api/labels', async () => repo.listLabels());

  app.post('/api/labels', async (req, reply) => {
    const b = asObject(req.body);
    const label = asLabelHttp(() => repo.createLabel(str(b, 'name', { allowEmpty: true })!, colorOf(b.color)));
    emitLabels();
    return reply.code(201).send(label);
  });

  app.post('/api/labels/apply', async (req) => {
    const b = asObject(req.body);
    const ids = idList(b.commentIds, 'commentIds', 500);
    const nums = (v: unknown, name: string): number[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > MAX_LABELS) throw bad(`"${name}" must be an array of label ids`);
      return v.map((x) => int(x, name, { min: 1 }));
    };
    const result = repo.applyLabels(ids, nums(b.add, 'add'), nums(b.remove, 'remove'));
    emitInbox(Object.keys(result.labels));
    return result;
  });

  app.patch<{ Params: { id: string } }>('/api/labels/:id', async (req) => {
    const id = int(req.params.id, 'id', { min: 1 });
    const b = asObject(req.body);
    const patch: { name?: string; color?: (typeof LABEL_COLORS)[number]; position?: number } = {};
    if (b.name !== undefined) patch.name = str(b, 'name', { allowEmpty: true })!;
    if (b.color !== undefined) patch.color = colorOf(b.color);
    if (b.position !== undefined) patch.position = int(b.position, 'position', { min: 0, max: 1_000_000 });
    const label = asLabelHttp(() => repo.updateLabel(id, patch));
    emitLabels();
    return label;
  });

  app.delete<{ Params: { id: string } }>('/api/labels/:id', async (req, reply) => {
    const id = int(req.params.id, 'id', { min: 1 });
    // Remember who carried the label so open lists can drop the chip.
    const affected = repo.listInbox({ view: 'all', labelId: id, limit: 500 }).items.map((i) => i.comment.id);
    asLabelHttp(() => repo.deleteLabel(id));
    emitLabels();
    emitInbox(affected);
    return reply.code(204).send();
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
    // "Sync now" means everything: GitHub feeds have their own limits, so they do not depend on YouTube's quota.
    if (scope === 'all') void deps.github?.pollNow().catch(() => undefined);
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
    if (b.github !== undefined) u.github = parseGithubUpdate(b.github);
    const llm = b.llm === undefined ? undefined : parseLlmUpdate(b.llm);
    const googleClient = b.googleClient === undefined ? undefined : parseGoogleClientUpdate(b.googleClient);

    const before = repo.getSettings();
    const { apiKey, googleClient: _ignored, github, llm: _llmIgnored, ...rest } = u;
    const patch: Parameters<typeof repo.updateSettings>[0] = { ...rest };
    if (github) {
      patch.github = {
        token: github.token === undefined ? before.github.token : github.token?.trim() || null,
        myAccounts: github.myAccounts ?? before.github.myAccounts,
      };
    }
    if (llm) {
      patch.llm = {
        apiKey: llm.apiKey === undefined ? before.llm.apiKey : llm.apiKey?.trim() || null,
        model: llm.model ?? before.llm.model,
      };
    }
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
    const githubChanged = JSON.stringify(before.github) !== JSON.stringify(after.github);
    if (githubChanged) {
      emitInbox([]);
      bus.emit({ type: 'feeds.changed', feeds: repo.listFeeds(), mutes: repo.listMuteRules() });
      // A new token (or new "me" accounts) is worth acting on straight away.
      if (before.github.token !== after.github.token) void deps.github?.pollNow().catch(() => undefined);
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
