import { YtError, type Repo, type SyncEngine, type YouTubeClient } from '../contracts.js';
import { parseSourceInput } from '../../shared/youtube-urls.js';
import type { ImportMode, SourceDTO } from '../../shared/types.js';
import { setOwnChannelId } from './own-channels.js';
import { attachVideos, fetchAllPlaylistItems } from './membership.js';

export type AddSource = (input: string, opts: { importMode?: ImportMode; isOwn?: boolean }) => Promise<SourceDTO>;

export interface AddSourceDeps {
  repo: Repo;
  yt: YouTubeClient;
  engine: SyncEngine;
  clock?: () => Date;
}

/**
 * Resolve user input (URL / id / @handle) into a source, attach its videos with metadata, then kick off
 * a background first sync. Throws YtError('badRequest') for unparseable input and YtError('notFound')
 * when YouTube doesn't know the thing.
 */
export function createAddSource(deps: AddSourceDeps): AddSource {
  const { repo, yt, engine } = deps;
  const clock = deps.clock ?? (() => new Date());

  return async (input, opts) => {
    const parsed = parseSourceInput(input);
    if (!parsed) throw new YtError('badRequest', 'Not a recognised YouTube video, playlist or channel');
    const importMode = opts.importMode ?? 'recent';
    const isOwn = opts.isOwn ?? false;

    let ytId = parsed.ytId;
    let title: string | null = null;
    let thumbnailUrl: string | null = null;
    let uploadsPlaylistId: string | null = null;
    let items: { videoId: string; position: number }[];

    if (parsed.kind === 'channel') {
      const ch = await yt.getChannel(parsed.ytId.startsWith('@') ? { handle: parsed.ytId } : { id: parsed.ytId });
      if (!ch) throw new YtError('notFound', `Channel ${parsed.ytId} not found`);
      ytId = ch.id;
      title = ch.title;
      thumbnailUrl = ch.thumbnailUrl;
      uploadsPlaylistId = ch.uploadsPlaylistId;
      if (!uploadsPlaylistId) throw new YtError('notFound', 'Channel has no uploads playlist');
    } else if (parsed.kind === 'playlist') {
      const pl = await yt.getPlaylist(parsed.ytId);
      if (!pl) throw new YtError('notFound', `Playlist ${parsed.ytId} not found`);
      title = pl.title;
      thumbnailUrl = pl.thumbnailUrl;
    }

    const existing = repo.listSources().find((s) => s.kind === parsed.kind && s.ytId === ytId);
    if (existing) {
      // "Add as mine" on an already-tracked channel just flips the flag.
      if (parsed.kind !== 'channel' || !isOwn) return existing;
      setOwnChannelId(repo, ytId, true);
      return existing.isOwn ? existing : repo.updateSource(existing.id, { isOwn: true });
    }

    if (parsed.kind === 'video') {
      const [video] = await yt.getVideos([parsed.ytId]);
      if (!video) throw new YtError('notFound', `Video ${parsed.ytId} not found`);
      title = video.title;
      thumbnailUrl = video.thumbnailUrl;
      items = [{ videoId: video.id, position: 0 }];
    } else {
      items = await fetchAllPlaylistItems(yt, parsed.kind === 'channel' ? (uploadsPlaylistId as string) : ytId);
    }

    const source = repo.addSource({
      kind: parsed.kind,
      ytId,
      title,
      thumbnailUrl,
      isOwn,
      importMode,
      uploadsPlaylistId,
    });
    // Flagging a channel as "mine" must also register it as an own-channel identity, otherwise
    // our replies are never recognised and threads never auto-clear.
    if (parsed.kind === 'channel' && isOwn) setOwnChannelId(repo, ytId, true);
    await attachVideos(repo, yt, source.id, items);
    repo.updateSource(source.id, { membershipRefreshedAt: clock().toISOString() });

    // First sync runs in the background; failures are recorded by the engine itself.
    void engine.run({ trigger: 'source-added', scope: 'source', id: source.id }).catch(() => {});
    return repo.listSources().find((s) => s.id === source.id) ?? source;
  };
}
