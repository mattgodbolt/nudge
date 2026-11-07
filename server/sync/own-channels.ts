import type { Repo } from '../contracts.js';

/**
 * The single place that keeps `ownChannelIds` (identity used to recognise our own comments) in step with a channel
 * source's `isOwn` flag. `repo.updateSettings` recomputes comment ownership when the ids change.
 * Returns true when the registered ids actually changed.
 */
export function setOwnChannelId(repo: Repo, channelId: string, own: boolean): boolean {
  const ids = repo.getSettings().ownChannelIds;
  if (ids.includes(channelId) === own) return false;
  repo.updateSettings({ ownChannelIds: own ? [...ids, channelId] : ids.filter((c) => c !== channelId) });
  return true;
}
