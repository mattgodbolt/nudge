import type { Repo } from '../contracts.js';
import { createAccounts } from './accounts.js';
import { openDb, type Db } from './db.js';
import { createDrafts } from './drafts.js';
import { createClientEvents, createEvents } from './events.js';
import { createFeedsRepo } from './feeds.js';
import { createInbox } from './inbox.js';
import { createNotes } from './notes.js';
import { createQuota } from './quota.js';
import { createSettings } from './settings.js';
import { createSnooze } from './snooze.js';
import { createSpend } from './spend.js';
import { createSuggestions } from './suggestions.js';
import { createTodosRepo } from './todos.js';
import { createTriage } from './triage.js';
import { createUsage } from './usage.js';
import { createYoutube } from './youtube.js';

export { UndoError, type UndoErrorCode } from './common.js';

/**
 * The repository: one store per concern, composed into the flat `Repo` the rest of the server uses. Each store takes
 * the few things it needs; the settings and the YouTube and GitHub stores refer to one another, so those edges are
 * lazy callbacks.
 */
export function createRepo(db: Db, clock: () => Date = () => new Date()): Repo {
  const now = () => clock().toISOString();

  const { putSetting, ...settings } = createSettings({
    db,
    now,
    recomputeOwnership: (ids) => youtube.recomputeOwnership(ids),
    recomputeGithubOwnership: () => feeds.recomputeGithubOwnership(),
  });
  const { getSettings } = settings;
  const events = createEvents(db);
  const { baselineFor, ...youtube } = createYoutube({ db, clock, now, events, getSettings, putSetting });
  const feeds = createFeedsRepo({
    db,
    now,
    events,
    myAccounts: () => new Set(getSettings().github.myAccounts.map((l) => l.toLowerCase())),
    baselineFor,
  });
  const { itemFromRow, ...feedMethods } = feeds;
  const inbox = createInbox({ db, clock, now, itemFromRow });
  const { counts, getComment } = inbox;
  const triage = createTriage({ db, clock, now, events, counts });
  const { saveDraft, ...drafts } = createDrafts({ db, now, getComment, triage: triage.triage });
  const accounts = createAccounts({
    db,
    now,
    events,
    saveDraft,
    triage: triage.triage,
    addReplies: youtube.addReplies,
  });

  return {
    ...feedMethods,
    ...createTodosRepo({ db, now }),
    close: () => void db.close(),
    usage: createUsage(db, clock),
    spend: createSpend(db, clock),
    suggestions: createSuggestions(db, clock),
    notes: createNotes(db, clock),
    clientEvents: createClientEvents(db),
    ...settings,
    ...youtube,
    ...inbox,
    ...triage,
    ...createSnooze({ db, clock, now, events, counts }),
    ...drafts,
    ...accounts,
    ...createQuota({ db, now }),
  };
}

export function openRepo(path: string, clock?: () => Date): Repo {
  return createRepo(openDb(path), clock);
}
