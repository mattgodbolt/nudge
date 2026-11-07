import {
  GatewayError,
  PostError,
  type GoogleAccountRow,
  type GoogleAuth,
  type PostGateway,
  type Repo,
  type YtComment,
} from '../contracts.js';
import type { GoogleAuthDTO } from '../../shared/types.js';
import { createWorld, DEMO_OWN_CHANNEL_ID, renderHtml, type DemoWorld } from './world.js';

export interface DemoPostingOptions {
  repo: Repo;
  /** The world the fake YouTube client serves; posted replies are appended to it. */
  world?: DemoWorld;
  bus?: unknown;
  clock?: () => Date;
  /** Called when connection state flips, so the caller can emit capabilities.changed / settings.changed. */
  onChange?: () => void;
}

const DEMO_TOKEN = 'demo-access-token';
const OWN_TITLE = 'Demo Channel';
const OWN_AVATAR = 'https://yt3.ggpht.com/demo/avatar-own=s48';

/**
 * Demo-mode stand-ins for Google OAuth and the authorised YouTube write calls (NUDGE_DEMO_POST=api).
 * Starts connected as the demo own channel; Disconnect/Connect toggle it in memory.
 * Comment text containing [[fail:quota]] or [[fail:auth]] makes insertReply fail, for e2e error paths.
 */
export function createDemoPosting(opts: DemoPostingOptions): { auth: GoogleAuth; gateway: PostGateway } {
  const world = opts.world ?? createWorld();
  const now = opts.clock ?? (() => new Date());
  const changed = () => opts.onChange?.();
  let connected = true;
  let connectedAt = now().toISOString();
  let seq = 0;

  const row = (): GoogleAccountRow => ({
    channelId: DEMO_OWN_CHANNEL_ID,
    title: OWN_TITLE,
    thumbnailUrl: OWN_AVATAR,
    refreshToken: 'demo',
    accessToken: DEMO_TOKEN,
    accessExpiresAt: null,
    scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
    connectedAt,
    needsReauth: false,
    lastError: null,
    isDefault: true,
  });

  const auth: GoogleAuth = {
    status(): GoogleAuthDTO {
      return {
        clientConfigured: true,
        clientSource: 'env',
        redirectUri: 'http://127.0.0.1/api/auth/callback',
        accounts: connected
          ? [
              {
                channelId: DEMO_OWN_CHANNEL_ID,
                title: OWN_TITLE,
                thumbnailUrl: OWN_AVATAR,
                connectedAt,
                needsReauth: false,
                lastError: null,
                isDefault: true,
              },
            ]
          : [],
      };
    },
    start(returnOrigin) {
      // Skip Google entirely: the "consent screen" is our own callback.
      return { url: `${returnOrigin}/api/auth/callback?code=demo&state=demo` };
    },
    async handleCallback(q) {
      const returnTo = '/settings';
      if (q.error) return { returnTo, result: 'denied' };
      connected = true;
      connectedAt = now().toISOString();
      changed();
      return { returnTo, result: 'connected' };
    },
    async getAccessToken() {
      if (!connected) throw new PostError('auth_required', 'Demo Google account is disconnected', 401);
      return { token: DEMO_TOKEN, channelId: DEMO_OWN_CHANNEL_ID };
    },
    async disconnect() {
      connected = false;
      changed();
    },
    setDefault() {},
    canPost: () => connected,
    pickAccount: () => (connected ? row() : null),
  };

  const gateway: PostGateway = {
    async insertReply(_token, p) {
      if (p.text.includes('[[fail:quota]]'))
        throw new GatewayError(
          'The request cannot be completed because you have exceeded your quota.',
          403,
          'quotaExceeded',
        );
      if (p.text.includes('[[fail:auth]]'))
        throw new GatewayError('Request had insufficient authentication scopes.', 403, 'insufficientPermissions');
      const thread = world.threadByCommentId.get(p.parentId);
      if (!thread || thread.id !== p.parentId)
        throw new GatewayError('The parent comment could not be found.', 404, 'parentCommentNotFound');
      const at = now().toISOString();
      const comment: YtComment = {
        id: `${p.parentId}.demoPosted${String(++seq).padStart(4, '0')}`,
        parentId: p.parentId,
        videoId: thread.videoId,
        authorName: OWN_TITLE,
        authorChannelId: DEMO_OWN_CHANNEL_ID,
        authorAvatarUrl: OWN_AVATAR,
        textHtml: renderHtml(p.text, thread.videoId),
        likeCount: 0,
        publishedAt: at,
        updatedAt: at,
      };
      thread.replies.push(comment);
      world.threadByCommentId.set(comment.id, thread);
      return comment;
    },
    async listReplies(_token, parentId) {
      const thread = world.threadByCommentId.get(parentId);
      if (!thread || thread.id !== parentId)
        throw new GatewayError('The parent comment could not be found.', 404, 'parentCommentNotFound');
      return [...thread.replies];
    },
    async deleteComment(_token, commentId) {
      const thread = world.threadByCommentId.get(commentId);
      const i = thread ? thread.replies.findIndex((c) => c.id === commentId) : -1;
      if (!thread || i < 0) throw new GatewayError('Comment not found.', 404, 'commentNotFound');
      thread.replies.splice(i, 1);
      world.threadByCommentId.delete(commentId);
    },
    async myChannel() {
      return connected ? { id: DEMO_OWN_CHANNEL_ID, title: OWN_TITLE, thumbnailUrl: OWN_AVATAR } : null;
    },
  };

  return { auth, gateway };
}
