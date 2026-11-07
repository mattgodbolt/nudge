import { PostError, type GoogleAccountRow, type GoogleAuth, type PostGateway } from '../contracts.js';

export function account(channelId: string, o: Partial<GoogleAccountRow> = {}): GoogleAccountRow {
  return {
    channelId,
    title: `Channel ${channelId}`,
    thumbnailUrl: null,
    refreshToken: 'refresh-secret',
    accessToken: 'access-secret',
    accessExpiresAt: null,
    scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
    connectedAt: '2026-01-01T00:00:00.000Z',
    needsReauth: false,
    lastError: null,
    isDefault: false,
    ...o,
  };
}

/** Scripted GoogleAuth: accounts are plain data, tokens are "tok-<channel>". */
export function fakeGoogleAuth(accounts: GoogleAccountRow[] = []): GoogleAuth & { accounts: GoogleAccountRow[] } {
  const self = {
    accounts,
    status: () => ({
      clientConfigured: true,
      clientSource: 'env' as const,
      redirectUri: 'http://127.0.0.1:4517/api/auth/callback',
      accounts: self.accounts.map((a) => ({
        channelId: a.channelId,
        title: a.title,
        thumbnailUrl: a.thumbnailUrl,
        connectedAt: a.connectedAt,
        needsReauth: a.needsReauth,
        lastError: a.lastError,
        isDefault: a.isDefault,
      })),
    }),
    start: () => ({ url: 'https://accounts.google.com/x' }),
    handleCallback: async () => ({ returnTo: '/settings', result: 'connected' }),
    async getAccessToken(channelId?: string) {
      const a = channelId ? self.accounts.find((x) => x.channelId === channelId) : self.pickAccount(null);
      if (!a || a.needsReauth) throw new PostError('auth_required', 'Sign in again', 401);
      return { token: `tok-${a.channelId}`, channelId: a.channelId };
    },
    async disconnect() {},
    setDefault() {},
    canPost: () => self.accounts.some((a) => !a.needsReauth),
    pickAccount(videoChannelId: string | null) {
      const usable = self.accounts.filter((a) => !a.needsReauth);
      return usable.find((a) => a.channelId === videoChannelId) ?? usable.find((a) => a.isDefault) ?? usable[0] ?? null;
    },
  };
  return self;
}

export type GatewayCall = { fn: string; args: unknown[] };

/** PostGateway whose behaviour is replaced per test; records every call. */
export function fakeGateway(impl: Partial<PostGateway> = {}): PostGateway & { calls: GatewayCall[] } {
  const calls: GatewayCall[] = [];
  const wrap = <K extends keyof PostGateway>(fn: K): PostGateway[K] =>
    ((...args: unknown[]) => {
      calls.push({ fn, args });
      const f = impl[fn] as ((...a: unknown[]) => unknown) | undefined;
      if (!f) throw new Error(`unscripted gateway call ${fn}`);
      return f(...args);
    }) as PostGateway[K];
  return {
    calls,
    insertReply: wrap('insertReply'),
    listReplies: wrap('listReplies'),
    deleteComment: wrap('deleteComment'),
    myChannel: wrap('myChannel'),
  };
}
