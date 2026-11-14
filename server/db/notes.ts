import { createHash } from 'node:crypto';
import type { NoteDTO, NoteScope } from '../../shared/types.js';
import type { Verdict } from '../classify/types.js';
import { ACTION_OF } from './suggestions.js';
import type { Db } from './db.js';

/** Most standing notes the classifier is ever shown (the newest), so a long list cannot grow every prompt. */
export const MAX_STANDING_IN_PROMPT = 20;
export const NOTE_TEXT_MAX = 1000;
/** How recent the owner's last action on an item must be for a note to record it, and to be about it by default. */
export const RECENT_ACTION_MS = 3_600_000;
const TITLE_MAX = 120;
/** Most item notes shown to the model for one item. */
const MAX_ITEM_NOTES = 3;

export interface NewNote {
  text: string;
  scope: NoteScope;
  source: 'voice' | 'text';
  /** The item the note is about (selected, or just acted on), if any. */
  itemId: string | null;
}

export interface RecentAction {
  itemId: string;
  kind: 'state' | 'snooze';
  to: string | null;
  at: string;
  why: string | null;
}

export interface NoteStore {
  /** Store a note verbatim with a snapshot of the suggestion, the owner's recent action and the item's context. */
  add(n: NewNote): NoteDTO;
  /** Newest first. */
  list(): NoteDTO[];
  get(id: number): NoteDTO | null;
  /** Change the text, the scope or whether the model sees it. The words first said are kept in originalText. */
  update(id: number, patch: { text?: string; scope?: NoteScope; enabled?: boolean }): NoteDTO | null;
  remove(id: number): NoteDTO | null;
  /** The enabled standing notes the classifier is shown (oldest first), and a fingerprint of them. */
  standing(): { texts: string[]; hash: string };
  /** Enabled notes about one item, newest first. */
  forItem(itemId: string): string[];
  /** The owner's newest state/snooze action on any item within the window, if there is one. */
  recentAction(withinMs?: number): RecentAction | null;
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function json(s: unknown): Row | null {
  if (typeof s !== 'string') return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const clean = (s: string, n: number): string => s.replace(/\s+/g, ' ').trim().slice(0, n);

function dto(r: Row): NoteDTO {
  const text = r.text as string;
  const original = r.original_text as string;
  return {
    id: r.id,
    createdAt: r.created_at,
    text,
    originalText: original,
    scope: r.scope,
    enabled: !!r.enabled,
    source: r.source,
    itemId: r.item_id ?? null,
    itemTitle: r.item_title ?? null,
    suggestion: json(r.suggestion) as NoteDTO['suggestion'],
    lastAction: json(r.last_action) as NoteDTO['lastAction'],
    context: json(r.context) as NoteDTO['context'],
  };
}

export function createNotes(db: Db, clock: () => Date = () => new Date()): NoteStore {
  /** The suggestion in force for the item, as the note records it. Tolerates a database from before migration 12. */
  function suggestionOf(itemId: string): NoteDTO['suggestion'] {
    let r: Row | undefined;
    try {
      r = db
        .prepare('SELECT verdict, turn, next_step, reason, confidence FROM suggestions WHERE item_id = ?')
        .get(itemId) as Row | undefined;
    } catch {
      return null;
    }
    return r
      ? {
          verdict: r.verdict as Verdict,
          action: ACTION_OF[r.verdict as Verdict] ?? 'skip',
          turn: r.turn ?? null,
          nextStep: r.next_step ?? null,
          reason: r.reason,
          confidence: r.confidence,
        }
      : null;
  }

  function actionOn(itemId: string, since: string): NoteDTO['lastAction'] {
    const r = db
      .prepare(
        `SELECT at, kind, to_value, meta FROM item_events
          WHERE item_id = ? AND source = 'user' AND kind IN ('state', 'snooze') AND at >= ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(itemId, since) as Row | undefined;
    if (!r) return null;
    const why = json(r.meta)?.why;
    return { kind: r.kind, to: r.to_value ?? null, at: r.at, why: typeof why === 'string' && why ? why : null };
  }

  function recentAction(withinMs = RECENT_ACTION_MS): RecentAction | null {
    const since = new Date(clock().getTime() - withinMs).toISOString();
    const r = db
      .prepare(
        `SELECT item_id, at, kind, to_value, meta FROM item_events
          WHERE source = 'user' AND kind IN ('state', 'snooze') AND at >= ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(since) as Row | undefined;
    if (!r) return null;
    const why = json(r.meta)?.why;
    return {
      itemId: r.item_id,
      kind: r.kind,
      to: r.to_value ?? null,
      at: r.at,
      why: typeof why === 'string' && why ? why : null,
    };
  }

  function itemInfo(itemId: string): { title: string | null; context: NoteDTO['context'] } {
    const r = db
      .prepare(
        `SELECT provider, kind, title, body_plain, container_key, container_title, author, data
           FROM items WHERE id = ?`,
      )
      .get(itemId) as Row | undefined;
    if (!r) return { title: null, context: null };
    const d = json(r.data) ?? {};
    const title = clean(r.title || r.body_plain || '', TITLE_MAX) || null;
    return {
      title,
      context: {
        provider: r.provider,
        kind: r.kind,
        container: clean(r.container_title ?? r.container_key ?? '', 140) || null,
        author: r.author ?? null,
        comments: typeof d.comments === 'number' ? d.comments : null,
        lastCommenter: typeof d.lastCommenter === 'string' && d.lastCommenter ? d.lastCommenter : null,
      },
    };
  }

  function get(id: number): NoteDTO | null {
    const r = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Row | undefined;
    return r ? dto(r) : null;
  }

  function add(n: NewNote): NoteDTO {
    const at = clock();
    const text = n.text.trim().slice(0, NOTE_TEXT_MAX);
    const info = n.itemId ? itemInfo(n.itemId) : { title: null, context: null };
    const since = new Date(at.getTime() - RECENT_ACTION_MS).toISOString();
    const suggestion = n.itemId ? suggestionOf(n.itemId) : null;
    const lastAction = n.itemId ? actionOn(n.itemId, since) : null;
    const res = db
      .prepare(
        `INSERT INTO notes (created_at, updated_at, text, original_text, scope, enabled, source, item_id, item_title,
                            suggestion, last_action, context)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at.toISOString(),
        at.toISOString(),
        text,
        text,
        n.scope,
        n.source,
        n.itemId,
        info.title,
        suggestion ? JSON.stringify(suggestion) : null,
        lastAction ? JSON.stringify(lastAction) : null,
        info.context ? JSON.stringify(info.context) : null,
      );
    return get(Number(res.lastInsertRowid))!;
  }

  function list(): NoteDTO[] {
    return (db.prepare('SELECT * FROM notes ORDER BY id DESC').all() as Row[]).map(dto);
  }

  function update(id: number, patch: { text?: string; scope?: NoteScope; enabled?: boolean }): NoteDTO | null {
    const cur = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Row | undefined;
    if (!cur) return null;
    db.prepare('UPDATE notes SET text = ?, scope = ?, enabled = ?, updated_at = ? WHERE id = ?').run(
      patch.text === undefined ? cur.text : patch.text.trim().slice(0, NOTE_TEXT_MAX),
      patch.scope ?? cur.scope,
      patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0,
      clock().toISOString(),
      id,
    );
    return get(id);
  }

  function remove(id: number): NoteDTO | null {
    const cur = get(id);
    if (!cur) return null;
    db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    return cur;
  }

  function standing(): { texts: string[]; hash: string } {
    const rows = db
      .prepare("SELECT text FROM notes WHERE scope = 'standing' AND enabled = 1 ORDER BY id DESC LIMIT ?")
      .all(MAX_STANDING_IN_PROMPT) as { text: string }[];
    const texts = rows.reverse().map((r) => r.text);
    const hash =
      texts.length === 0 ? '' : createHash('sha256').update(JSON.stringify(texts)).digest('hex').slice(0, 12);
    return { texts, hash };
  }

  function forItem(itemId: string): string[] {
    return (
      db
        .prepare("SELECT text FROM notes WHERE item_id = ? AND scope = 'item' AND enabled = 1 ORDER BY id DESC LIMIT ?")
        .all(itemId, MAX_ITEM_NOTES) as { text: string }[]
    ).map((r) => r.text);
  }

  return { add, list, get, update, remove, standing, forItem, recentAction };
}
