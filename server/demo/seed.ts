import type { Repo } from '../contracts.js';
import type { AddSource } from '../sync/sources.js';
import { DEMO_OWN_CHANNEL_ID, DEMO_PLAYLIST_A, DEMO_PLAYLIST_B, DEMO_STANDALONE_VIDEOS } from './world.js';

export { DEMO_OWN_CHANNEL_ID };

/** On an empty repo: mark the demo channel as ours and add the demo sources. No-op otherwise. */
export async function seedDemo(repo: Repo, addSource: AddSource): Promise<void> {
  if (repo.listSources().length > 0) return;
  repo.updateSettings({ ownChannelIds: [DEMO_OWN_CHANNEL_ID] });
  await addSource(DEMO_OWN_CHANNEL_ID, { isOwn: true, importMode: 'recent' });
  await addSource(DEMO_PLAYLIST_A, { importMode: 'recent' });
  await addSource(DEMO_PLAYLIST_B, { importMode: 'recent' });
  for (const id of DEMO_STANDALONE_VIDEOS) await addSource(id, { importMode: 'recent' });
}

/** Sources in this DB that don't belong to the demo world: demo mode must never run against real data. */
export function nonDemoSources(repo: Repo): string[] {
  const demo = new Set([DEMO_OWN_CHANNEL_ID, DEMO_PLAYLIST_A, DEMO_PLAYLIST_B, ...DEMO_STANDALONE_VIDEOS]);
  return repo
    .listSources()
    .filter((s) => !demo.has(s.ytId))
    .map((s) => s.title ?? s.ytId);
}
