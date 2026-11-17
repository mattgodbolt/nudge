import type { FastifyInstance } from 'fastify';
import type { AssistantOutcome } from '../../shared/types.js';
import type { AssistantAction, AppDeps } from '../contracts.js';
import { LlmError } from '../contracts.js';
import { costMicros } from '../classify/anthropic.js';
import { groundTodo, groundedInCommand } from '../providers/anthropic/client.js';
import { fallbackDate } from '../../shared/snooze.js';
import { recordNote } from './notes.js';
import { bucketInBackground } from './snoozeAi.js';
import { overDailyCap } from '../suggest/worker.js';
import { ownerProfileComplete } from '../../shared/owner.js';
import { HttpError, asObject, bad, logBackground, notFound, ownerProfileMissing, str } from './util.js';

const TEXT_MAX = 4000;
const TITLE_MAX = 140;
/** A local time with its UTC offset, e.g. 2026-11-08T13:05:00-06:00 (or Z). */
const LOCAL_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Used when the assistant is off or fails: the first line, trimmed. */
export function roughTitle(text: string): string {
  const first = text.trim().split(/\n/)[0]!.trim();
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

export function registerTodoRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { repo, bus } = deps;
  // Analytics must never be the reason a command is lost.
  const usage = {
    add(counts: Record<string, number>) {
      try {
        repo.usage.add(counts);
      } catch (e) {
        console.error('usage counter failed', e);
      }
    },
  };
  const emitInbox = (changedIds: string[], addedIds: string[] = []) =>
    bus.emit({ type: 'inbox.changed', counts: repo.counts(), addedIds, changedIds });

  /**
   * Run a spoken or typed command. Whatever happens, the words are never lost: if the assistant is off, fails, or
   * decides on nothing it can do, the text is saved as a plain todo.
   */
  app.post('/api/assistant', async (req, reply) => {
    const b = asObject(req.body);
    const text = str(b, 'text')!.trim();
    if (!text) throw bad('Say what you want');
    if (text.length > TEXT_MAX) throw bad(`Keep it under ${TEXT_MAX} characters`);
    const now = typeof b.now === 'string' && LOCAL_NOW.test(b.now) ? b.now : new Date().toISOString();
    const selectedId = typeof b.selectedId === 'string' && b.selectedId.length < 200 ? b.selectedId : null;
    const selected = selectedId ? repo.getItem(selectedId) : null;
    const via = b.via === 'voice' ? 'voice' : 'text';
    const last = repo.notes.recentAction();
    const lastItem = last ? repo.getItem(last.itemId) : null;
    const recent =
      last && lastItem
        ? {
            what: last.kind === 'snooze' ? (last.to ? 'snoozed' : 'unsnoozed') : `marked ${last.to ?? 'changed'}`,
            minutesAgo: Math.min(60, Math.max(0, Math.round((Date.now() - Date.parse(last.at)) / 60_000))),
          }
        : null;

    const { llm, owner } = repo.getSettings();
    const { apiKey, model } = llm;
    // With a key the words are meant for the model, which is paused until the profile is filled in: say so, and the
    // browser keeps the words in the box (nothing is saved, so nothing is lost or half done).
    if (apiKey && deps.llm && !ownerProfileComplete(owner)) return ownerProfileMissing(reply);
    let actions: AssistantAction[] = [];
    let said = '';
    let fallback: 'off' | 'failed' | null = null;
    let error: string | null = null;
    if (!apiKey || !deps.llm) {
      fallback = 'off';
    } else if (overDailyCap(repo)) {
      // The assistant draws on the same daily cap as suggestions; the words are still kept below.
      fallback = 'failed';
      error = 'The daily limit on model spending has been reached';
    } else {
      try {
        const r = await deps.llm.command(
          {
            text,
            now,
            selected: selected ? { kind: selected.item.kind, source: selected.item.provider } : null,
            recent,
          },
          apiKey,
          model,
        );
        actions = r.actions;
        said = r.reply;
        const micros = r.tokens ? costMicros(model, r.tokens) : 0;
        repo.spend.add('assistant', micros);
        // Counts only: how often the assistant is used, what it did and what it cost. Never the words.
        usage.add({
          'assistant.call': 1,
          ...(r.actions.length ? { 'assistant.tool_call': r.actions.length } : {}),
          ...(micros > 0 ? { 'assistant.cost_micros': micros } : {}),
        });
      } catch (e) {
        usage.add({ 'assistant.call': 1, 'assistant.fail': 1 });
        fallback = 'failed';
        error = e instanceof LlmError ? e.message : e instanceof Error ? e.message : String(e);
      }
    }
    // Nothing usable came back: keep the words as a todo rather than lose them.
    if (actions.length === 0 && (fallback || !said)) {
      actions = [{ type: 'add_todo', title: roughTitle(text), notes: '', due: null }];
      fallback ??= 'failed';
    }

    const outcomes: AssistantOutcome[] = [];
    const added: string[] = [];
    const changed: string[] = [];
    let skipped = false;
    for (const a of actions) {
      if (a.type === 'add_todo') {
        // Checked here too, so no LlmClient can put words the owner never said into a todo.
        const g = groundTodo(a.title, a.notes, text);
        if (!g.title) continue;
        const id = repo.addTodo({ title: g.title, notes: g.notes, raw: text, dueAt: a.due });
        added.push(id);
        outcomes.push({ type: 'add_todo', id, title: g.title, due: a.due });
      } else if (a.type === 'note') {
        // Checked here too, so no LlmClient can store words the owner never said.
        if (!groundedInCommand(a.text, text)) continue;
        // What the owner said about a suggestion or an item is kept whatever else happens. "That" is the item they are
        // on, or the one they have just dealt with (the selection has usually moved on by then).
        const latest = repo.notes.recentAction();
        const itemId =
          a.about === 'last_action'
            ? (latest?.itemId ?? selected?.item.id ?? null)
            : (selected?.item.id ?? latest?.itemId ?? null);
        const note = recordNote(deps, { text: a.text, scope: a.scope, source: via, itemId });
        outcomes.push({ type: 'note', id: note.id, scope: note.scope, text: note.text, itemId: note.itemId });
      } else if (!selected || selected.state !== 'inbox') {
        skipped = true;
      } else if (a.type === 'snooze') {
        // Waiting on activity with no date of its own: the bucket's follow-up from Settings.
        // Ungrounded reasons are dropped here too: the reason reaches the classifier as the owner's own words.
        const why = a.why && groundedInCommand(a.why, text) ? a.why : null;
        const until = a.until ?? fallbackDate(new Date(), a.bucket, repo.getSettings().snoozeDays).toISOString();
        const r = repo.snooze([selected.item.id], until, why, { bucket: a.bucket, untilActivity: a.untilActivity });
        changed.push(selected.item.id);
        outcomes.push({
          type: 'snooze',
          id: selected.item.id,
          until,
          why,
          bucket: a.bucket,
          untilActivity: a.untilActivity,
          undoActionId: r.actionId,
        });
        // A reason in words with no bucket from the assistant: file it afterwards, never holding up the answer.
        if (!a.bucket && why && r.actionId !== null) {
          void bucketInBackground(deps, r.actionId, [selected.item.id], logBackground);
        }
      } else if (a.type === 'dismiss') {
        const r = repo.triage([selected.item.id], 'done', 'no_action');
        changed.push(selected.item.id);
        outcomes.push({ type: 'dismissed', id: selected.item.id, undoActionId: r.actionId });
      } else {
        const r = repo.triage([selected.item.id], 'done');
        changed.push(selected.item.id);
        outcomes.push({ type: 'done', id: selected.item.id, undoActionId: r.actionId });
      }
    }
    if (added.length || changed.length) emitInbox(changed, added);
    if (skipped && outcomes.length === 0) said = said || 'Select an item first, then try again.';
    return reply.code(201).send({ outcomes, reply: said, fallback, error });
  });

  /** Undo a todo's creation. */
  app.delete<{ Params: { id: string } }>('/api/todos/:id', async (req, reply) => {
    if (!req.params.id.startsWith('todo:')) throw new HttpError(400, 'Not a todo', 'bad_request');
    if (!repo.deleteTodo(req.params.id)) throw notFound('Todo');
    emitInbox([req.params.id]);
    return reply.code(204).send();
  });

  /** Settings "Test": does the key work? Uses the stored key when none is typed. */
  app.post('/api/settings/test-llm', async (req) => {
    const b = req.body === undefined || req.body === null ? {} : asObject(req.body);
    const stored = repo.getSettings().llm;
    const key = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : stored.apiKey;
    if (!key) return { ok: false, message: 'No key to test' };
    if (!deps.llm) return { ok: false, message: 'The assistant is not available' };
    return deps.llm.test(key, stored.model);
  });
}
