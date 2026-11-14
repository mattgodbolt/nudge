import type { FastifyInstance } from 'fastify';
import type { ImportMode, MuteKind } from '../../shared/types.js';
import type { AppDeps } from '../contracts.js';
import { GithubError } from '../contracts.js';
import { createDiscussionService } from '../providers/github/discussion.js';
import { HttpError, asObject, bad, bool, notFound, oneOf, str } from './util.js';

const IMPORT_MODES = ['none', 'recent', 'all'] as const;
const MUTE_KINDS = ['repo', 'owner', 'author', 'bots', 'item'] as const;
/** A GitHub login: alphanumerics and single hyphens, up to 39 characters (and "[bot]" accounts when matching). */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[\w.-]{1,100}$/;

export function registerGithubRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo, bus } = deps;
  const emitFeeds = () => bus.emit({ type: 'feeds.changed', feeds: repo.listFeeds(), mutes: repo.listMuteRules() });
  const emitInbox = (changedIds: string[]) =>
    bus.emit({ type: 'inbox.changed', counts: repo.counts(), addedIds: [], changedIds });
  const poll = (feedId?: number) => {
    void deps.github?.pollNow(feedId).catch((e: unknown) => {
      bus.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  };

  const discussions = deps.githubClient
    ? createDiscussionService({ client: deps.githubClient, getToken: () => repo.getSettings().github.token })
    : null;

  /**
   * The conversation on one GitHub item, fetched live with the stored token (which never leaves the server). Any
   * failure at GitHub is a 424 with a plain message (not 502: the web client retries 502 for a restarting server): the pane keeps showing what it has and notes the problem.
   */
  app.get<{ Params: { id: string } }>('/api/items/:id/discussion', async (req) => {
    const found = repo.getItem(req.params.id);
    const g = found?.item.github;
    if (!found || found.item.provider !== 'github' || !g) throw notFound('Item');
    if (!discussions) throw new HttpError(424, 'GitHub is not available', 'github_unavailable');
    try {
      return await discussions.get({
        id: found.item.id,
        repo: `${g.owner}/${g.repo}`,
        number: g.number,
        kind: found.item.kind === 'pr' ? 'pr' : 'issue',
        comments: g.comments,
        sourceState: found.item.sourceState,
      });
    } catch (e) {
      if (e instanceof GithubError) {
        throw new HttpError(424, e.message, e.status === 404 ? 'github_not_found' : 'github_unavailable');
      }
      throw e;
    }
  });

  app.get('/api/feeds', async () => ({ feeds: repo.listFeeds(), mutes: repo.listMuteRules() }));

  app.post('/api/feeds', async (req, reply) => {
    const b = asObject(req.body);
    const owner = str(b, 'owner')!
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\/+$/, '');
    if (!LOGIN.test(owner) || owner.endsWith('[bot]')) throw bad('"owner" must be a GitHub user or organisation name');
    const prs = bool(b, 'prs') ?? true;
    const issues = bool(b, 'issues') ?? true;
    if (!prs && !issues) throw bad('Pick pull requests, issues, or both');
    const importMode: ImportMode =
      b.importMode === undefined ? 'none' : oneOf(b.importMode, 'importMode', IMPORT_MODES);
    if (repo.listFeeds().some((f) => f.owner.toLowerCase() === owner.toLowerCase())) {
      throw new HttpError(409, `${owner} is already a feed`, 'duplicate_feed');
    }
    const feed = repo.addFeed({ owner, prs, issues, importMode });
    emitFeeds();
    poll(feed.id);
    return reply.code(201).send(feed);
  });

  app.patch<{ Params: { id: string } }>('/api/feeds/:id', async (req) => {
    const id = Number(req.params.id);
    const b = asObject(req.body);
    const patch: Parameters<typeof repo.updateFeed>[1] = {};
    const enabled = bool(b, 'enabled');
    const prs = bool(b, 'prs');
    const issues = bool(b, 'issues');
    if (enabled !== undefined) patch.enabled = enabled;
    if (prs !== undefined) patch.prs = prs;
    if (issues !== undefined) patch.issues = issues;
    const cur = repo.getFeed(id);
    if (!cur) throw notFound('Feed');
    if (!(patch.prs ?? cur.prs) && !(patch.issues ?? cur.issues)) throw bad('Pick pull requests, issues, or both');
    const feed = repo.updateFeed(id, patch)!;
    emitFeeds();
    return feed;
  });

  app.delete<{ Params: { id: string } }>('/api/feeds/:id', async (req, reply) => {
    if (!repo.deleteFeed(Number(req.params.id))) throw notFound('Feed');
    emitFeeds();
    emitInbox([]);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/feeds/:id/poll', async (req, reply) => {
    const id = Number(req.params.id);
    if (!repo.getFeed(id)) throw notFound('Feed');
    poll(id);
    return reply.code(202).send(repo.getFeed(id));
  });

  /** Mute a repo, a whole owner (user or organisation), an author, all bots, or one item. Items already in the inbox are archived (undoable). */
  app.post('/api/mutes', async (req) => {
    const b = asObject(req.body);
    const kind: MuteKind = oneOf(b.kind, 'kind', MUTE_KINDS);
    const value = kind === 'bots' ? '' : str(b, 'value')!.trim();
    if (kind === 'repo' && !REPO.test(value)) throw bad('"value" must look like owner/repo');
    if (kind === 'owner' && !LOGIN.test(value)) throw bad('"value" must be a GitHub user or organisation name');
    if (kind === 'author' && !LOGIN.test(value)) throw bad('"value" must be a GitHub login');
    if (kind === 'item' && !value.startsWith('gh:')) throw bad('"value" must be a GitHub item id');
    const { rule, affectedIds } = repo.addMuteRule(kind, value);
    const triage = affectedIds.length > 0 ? repo.triage(affectedIds, 'archived') : null;
    emitFeeds();
    emitInbox(affectedIds);
    return { rule, triage };
  });

  app.delete<{ Params: { id: string } }>('/api/mutes/:id', async (req, reply) => {
    if (!repo.deleteMuteRule(Number(req.params.id))) throw notFound('Mute rule');
    emitFeeds();
    return reply.code(204).send();
  });

  /** Settings "Test": who does the token belong to, and does it carry more power than this app needs? */
  app.post('/api/settings/test-github', async (req) => {
    const b = req.body === undefined || req.body === null ? {} : asObject(req.body);
    const token = typeof b.token === 'string' && b.token.trim() ? b.token.trim() : repo.getSettings().github.token;
    if (!token) return { ok: false, message: 'No token to test' };
    if (!deps.githubClient) return { ok: false, message: 'GitHub is not available' };
    try {
      const who = await deps.githubClient.whoami(token);
      const risky = (who.scopes ?? []).filter((s) => /^(repo|admin:|write:|delete_|workflow|gist|user)/.test(s));
      return {
        ok: true,
        login: who.login,
        scopes: who.scopes,
        message:
          risky.length > 0
            ? `Signed in as ${who.login}, but this token can do more than read (${risky.join(', ')}). Prefer a read-only token.`
            : `Signed in as ${who.login}`,
      };
    } catch (e) {
      if (e instanceof GithubError) return { ok: false, message: e.message };
      throw e;
    }
  });
}
