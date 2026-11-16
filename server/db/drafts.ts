import type { DraftDTO } from '../../shared/api.js';
import type { TriageResult } from '../../shared/types.js';
import type { Repo } from '../contracts.js';
import type { Row } from './common.js';
import type { Db } from './db.js';

export interface DraftsStore extends Pick<Repo, 'getDraft' | 'putDraft' | 'deleteDraft' | 'markHandedOff'> {
  /** Store a draft with any status (putDraft is the 'draft' case). */
  saveDraft(commentId: string, body: string, status: DraftDTO['status']): DraftDTO;
}

export interface DraftsDeps {
  db: Db;
  now: () => string;
  getComment: Repo['getComment'];
  triage: Repo['triage'];
}

/** Reply drafts, and handing one off to be posted elsewhere. */
export function createDrafts(deps: DraftsDeps): DraftsStore {
  const { db, now, getComment, triage } = deps;

  function draftDto(r: Row): DraftDTO {
    return { body: r.body, updatedAt: r.updated_at, status: r.status };
  }
  function getDraft(commentId: string): DraftDTO | null {
    const r = db.prepare('SELECT * FROM drafts WHERE item_id = ?').get(commentId) as Row | undefined;
    return r ? draftDto(r) : null;
  }
  function saveDraft(commentId: string, body: string, status: DraftDTO['status']): DraftDTO {
    db.prepare(
      `INSERT INTO drafts (item_id, body, updated_at, status) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at,
         status = excluded.status`,
    ).run(commentId, body, now(), status);
    return getDraft(commentId)!;
  }

  function markHandedOff(commentId: string, body: string): TriageResult {
    return db.transaction(() => {
      if (!getComment(commentId)) throw new Error(`Unknown comment ${commentId}`);
      saveDraft(commentId, body, 'handed_off');
      return triage([commentId], 'replied');
    })();
  }

  return {
    getDraft,
    saveDraft,
    putDraft: (commentId, body) => saveDraft(commentId, body, 'draft'),
    deleteDraft: (commentId) => void db.prepare('DELETE FROM drafts WHERE item_id = ?').run(commentId),
    markHandedOff,
  };
}
