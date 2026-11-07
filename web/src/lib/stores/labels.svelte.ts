import type { LabelColor, LabelDTO } from '../../../../shared/types';
import { api } from '../api';
import { toasts } from './toasts.svelte';

/** CSS custom property holding a label colour; defined (light + dark) in styles/tokens.css. */
export const labelColorVar = (c: LabelColor) => `var(--label-${c})`;

class LabelsStore {
  list = $state<LabelDTO[]>([]);
  loaded = $state(false);

  set(list: LabelDTO[]) {
    this.list = [...list].sort((a, b) => a.position - b.position || a.id - b.id);
    this.loaded = true;
  }
  get(id: number): LabelDTO | undefined {
    return this.list.find((l) => l.id === id);
  }
  /** Labels for a comment's label ids, in sidebar order; ids that no longer exist are skipped. */
  resolve(ids: readonly number[]): LabelDTO[] {
    return this.list.filter((l) => ids.includes(l.id));
  }

  async create(name: string, color?: LabelColor): Promise<LabelDTO | null> {
    try {
      const l = await api.createLabel(name, color);
      this.set([...this.list.filter((x) => x.id !== l.id), l]);
      return l;
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not create label');
      return null;
    }
  }
  async patch(id: number, patch: Partial<Pick<LabelDTO, 'name' | 'color' | 'position'>>): Promise<boolean> {
    const prev = this.list;
    this.set(this.list.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    try {
      const l = await api.patchLabel(id, patch);
      this.set(this.list.map((x) => (x.id === id ? l : x)));
      return true;
    } catch (e) {
      this.set(prev);
      toasts.error(e instanceof Error ? e.message : 'Could not update label');
      return false;
    }
  }
  /** Swap with the neighbour in `dir`; positions are rewritten so the order is stable. */
  async move(id: number, dir: -1 | 1): Promise<void> {
    const i = this.list.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.list.length) return;
    const a = this.list[i]!;
    const b = this.list[j]!;
    // Distinct positions even if the two had equal ones.
    const [pa, pb] = a.position === b.position ? [j, i] : [b.position, a.position];
    const prev = this.list;
    this.set(
      this.list.map((l) => (l.id === a.id ? { ...l, position: pa } : l.id === b.id ? { ...l, position: pb } : l)),
    );
    try {
      await Promise.all([api.patchLabel(a.id, { position: pa }), api.patchLabel(b.id, { position: pb })]);
    } catch (e) {
      this.set(prev);
      toasts.error(e instanceof Error ? e.message : 'Could not reorder labels');
    }
  }
  async remove(id: number): Promise<boolean> {
    const prev = this.list;
    this.set(this.list.filter((l) => l.id !== id));
    try {
      await api.deleteLabel(id);
      return true;
    } catch (e) {
      this.set(prev);
      toasts.error(e instanceof Error ? e.message : 'Could not delete label');
      return false;
    }
  }
}

export const labels = new LabelsStore();
