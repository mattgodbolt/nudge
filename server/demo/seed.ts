import { ownerProfileComplete } from '../../shared/owner.js';
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

/** The demo's owner (Settings > About you), so the faked model features run without setup. */
export const DEMO_OWNER = {
  name: 'Alex',
  about: 'Alex makes videos about programming and maintains a few open-source projects.',
} as const;

/** Give a demo database an owner when it has none. A profile someone typed into the demo is left alone. */
export function seedDemoOwner(repo: Pick<Repo, 'getSettings' | 'updateSettings'>): void {
  if (ownerProfileComplete(repo.getSettings().owner)) return;
  repo.updateSettings({ owner: { ...DEMO_OWNER } });
}

/** Sources in this DB that don't belong to the demo world: demo mode must never run against real data. */
export function nonDemoSources(repo: Repo): string[] {
  const demo = new Set([DEMO_OWN_CHANNEL_ID, DEMO_PLAYLIST_A, DEMO_PLAYLIST_B, ...DEMO_STANDALONE_VIDEOS]);
  return repo
    .listSources()
    .filter((s) => !demo.has(s.ytId))
    .map((s) => s.title ?? s.ytId);
}

/** Inbox positions (newest first) that start out snoozed; deep in the list so the top rows stay untouched. */
const DEMO_SNOOZED_AT = [12, 27, 41];
const DEMO_SNOOZE_DAYS = [300, 330, 360];
const DEMO_DECORATE_MIN_INBOX = 60;

/**
 * Give a freshly seeded demo a few snoozed comments so the UI has something to show. Runs after the
 * first sync has produced comments (returns false until there are enough) and picks comments by position, never
 * touching the world's rng, so the generated data and the done/all counts are unchanged.
 */
export function decorateDemo(repo: Repo, now: Date = new Date()): boolean {
  const items = repo.listInbox({ view: 'inbox', limit: 500 }).items;
  if (items.length < DEMO_DECORATE_MIN_INBOX) return false;
  DEMO_SNOOZED_AT.forEach((at, i) => {
    const until = new Date(now.getTime() + DEMO_SNOOZE_DAYS[i]! * 24 * 60 * 60 * 1000).toISOString();
    repo.snooze([items[at]!.comment.id], until);
  });
  return true;
}
