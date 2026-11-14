import type { NoteDTO, NoteScope } from '../../../../shared/types';
import { api } from '../api';
import { toasts } from './toasts.svelte';

/** What the owner has told the assistant: kept on record, editable, and switchable off for the model. */
class NotesStore {
  list = $state<NoteDTO[]>([]);
  loaded = $state(false);

  set(notes: NoteDTO[]) {
    this.list = notes;
    this.loaded = true;
  }

  async load() {
    try {
      this.set(await api.notes());
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not load notes');
    }
  }

  async patch(id: number, patch: { text?: string; enabled?: boolean; scope?: NoteScope }) {
    const prev = this.list;
    this.list = this.list.map((n) => (n.id === id ? { ...n, ...patch } : n));
    try {
      const n = await api.patchNote(id, patch);
      this.list = this.list.map((x) => (x.id === id ? n : x));
    } catch (e) {
      this.list = prev;
      toasts.error(e instanceof Error ? e.message : 'Could not update the note');
    }
  }

  async remove(id: number) {
    const prev = this.list;
    this.list = this.list.filter((n) => n.id !== id);
    try {
      await api.deleteNote(id);
    } catch (e) {
      this.list = prev;
      toasts.error(e instanceof Error ? e.message : 'Could not delete the note');
    }
  }
}

export const notes = new NotesStore();
