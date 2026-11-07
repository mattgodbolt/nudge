import type { Repo, YouTubeClient } from '../contracts.js';

const MAX_PLAYLIST_PAGES = 200;

export async function fetchAllPlaylistItems(
  yt: YouTubeClient,
  playlistId: string,
): Promise<{ videoId: string; position: number }[]> {
  const out: { videoId: string; position: number }[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PLAYLIST_PAGES; i++) {
    const page = await yt.listPlaylistItems({ playlistId, pageToken });
    for (const it of page.items) {
      if (seen.has(it.videoId)) continue;
      seen.add(it.videoId);
      out.push(it);
    }
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return out;
}

/**
 * Attach videos to a source and fill in metadata for the newly seen ones (batched, 1 unit per 50).
 * Videos the API doesn't return (private/deleted) are flagged missing so they're never polled.
 * Stubs left without metadata by an earlier failed getVideos (null meta_refreshed_at) are retried here too,
 * so they don't sit in the default tier with no publish date.
 */
export async function attachVideos(
  repo: Repo,
  yt: YouTubeClient,
  sourceId: number,
  items: { videoId: string; position: number }[],
): Promise<{ added: string[]; missing: string[] }> {
  const { added } = repo.setSourceVideos(
    sourceId,
    items.map((i) => ({ id: i.videoId, position: i.position })),
  );
  const fetchIds = new Set(added);
  for (const i of items) {
    const row = repo.getVideoSyncRow(i.videoId);
    if (row && !row.missing && !row.metaRefreshedAt) fetchIds.add(i.videoId);
  }
  if (!fetchIds.size) return { added, missing: [] };
  const wanted = [...fetchIds];
  const videos = await yt.getVideos(wanted);
  repo.upsertVideos(videos);
  const found = new Set(videos.map((v) => v.id));
  const missing = wanted.filter((id) => !found.has(id));
  for (const id of missing)
    repo.updateVideoSync(id, { missing: true, lastError: 'Video not found (private or deleted)' });
  return { added, missing };
}

export async function refreshVideoMetadata(repo: Repo, yt: YouTubeClient, sourceId: number): Promise<void> {
  const ids = repo
    .allVideoRows(sourceId)
    .filter((v) => !v.missing)
    .map((v) => v.id);
  if (ids.length) repo.upsertVideos(await yt.getVideos(ids));
}

/**
 * One-off backfill of duration and like counts for videos stored before those columns existed. getVideos batches 50 ids
 * per 1-unit call, so a few hundred videos cost a handful of units. Returns how many videos were updated.
 */
export async function backfillVideoDetails(repo: Repo, yt: YouTubeClient): Promise<number> {
  const ids = repo.videosMissingDetails();
  let updated = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const found = await yt.getVideos(ids.slice(i, i + 50));
    repo.upsertVideos(found);
    updated += found.length;
  }
  return updated;
}
