import type { FastifyInstance } from 'fastify';
import type { NoteDTO, NoteScope } from '../../shared/types.js';
import type { AppDeps } from '../contracts.js';
import { NOTE_TEXT_MAX } from '../db/notes.js';
import { HttpError, asObject, bad, bool, int, notFound, oneOf } from './util.js';

const SCOPES = ['item', 'standing'] as const;

/**
 * Store a note the owner made and tell everything that cares. Used by the assistant; the note is the point, so this
 * does nothing that could fail it (the worker nudge is best effort).
 */
export function recordNote(
  deps: AppDeps,
  n: { text: string; scope: NoteScope; source: 'voice' | 'text'; itemId: string | null },
): NoteDTO {
  const note = deps.repo.notes.add(n);
  announce(deps, note);
  return note;
}

/** Everyone who shows or uses notes hears about a change; the suggestions the note can affect are looked at again. */
export function announce(deps: AppDeps, note: Pick<NoteDTO, 'scope' | 'itemId'>): void {
  deps.bus.emit({ type: 'notes.changed', notes: deps.repo.notes.list() });
  try {
    if (note.scope === 'standing') deps.suggest?.kick();
    else if (note.itemId) deps.suggest?.notify([note.itemId]);
  } catch {
    // Advisory work must never fail a note.
  }
}

export function registerNoteRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo } = deps;

  app.get('/api/notes', async () => repo.notes.list());

  app.patch<{ Params: { id: string } }>('/api/notes/:id', async (req) => {
    const id = int(req.params.id, 'id', { min: 1 });
    const b = asObject(req.body);
    const patch: { text?: string; scope?: NoteScope; enabled?: boolean } = {};
    if (b.text !== undefined) {
      if (typeof b.text !== 'string' || !b.text.trim()) throw bad('"text" must not be empty');
      if (b.text.length > NOTE_TEXT_MAX) throw bad(`Keep a note under ${NOTE_TEXT_MAX} characters`);
      patch.text = b.text;
    }
    if (b.scope !== undefined) patch.scope = oneOf(b.scope, 'scope', SCOPES);
    const enabled = bool(b, 'enabled');
    if (enabled !== undefined) patch.enabled = enabled;
    if (Object.keys(patch).length === 0) throw bad('No updatable fields supplied');
    const before = repo.notes.get(id);
    if (!before) throw notFound('Note');
    const note = repo.notes.update(id, patch)!;
    announce(deps, note);
    // Changing scope moves the note between the standing block and one item's prompt: look at both again.
    if (before.scope !== note.scope) {
      if (before.itemId) deps.suggest?.notify([before.itemId]);
      deps.suggest?.kick();
    }
    return note;
  });

  app.delete<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
    const id = int(req.params.id, 'id', { min: 1 });
    const gone = repo.notes.remove(id);
    if (!gone) throw new HttpError(404, 'Note not found', 'not_found');
    announce(deps, gone);
    return reply.code(204).send();
  });
}
