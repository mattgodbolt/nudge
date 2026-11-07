import type { Repo, ReplyPoster } from '../contracts.js';

/**
 * Phase 1 poster: we never talk to YouTube. The browser copies the text and opens the
 * comment permalink; the server just records the hand-off (draft status, replied state,
 * undoable triage action). A future ApiPoster implements the same interface and is picked
 * in index.ts, so routes and UI need no change.
 */
export function createHandoffPoster(repo: Repo): ReplyPoster {
  return {
    capabilities: () => ({ canPost: false, postMode: 'handoff' }),
    async reply(comment, body) {
      const result = repo.markHandedOff(comment.id, body);
      return { mode: 'handoff', url: comment.permalink, actionId: result.actionId };
    },
  };
}
