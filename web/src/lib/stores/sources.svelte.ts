import type { ImportMode, SourceDTO } from '../../../../shared/types';
import { api } from '../api';
import { toasts } from './toasts.svelte';

class SourcesStore {
  list = $state<SourceDTO[]>([]);
  loaded = $state(false);

  set(list: SourceDTO[]) {
    this.list = list;
    this.loaded = true;
  }
  get(id: number): SourceDTO | undefined {
    return this.list.find((s) => s.id === id);
  }
  async load() {
    this.set(await api.sources());
  }
  async add(input: string, opts: { importMode?: ImportMode; isOwn?: boolean }): Promise<SourceDTO | null> {
    try {
      const s = await api.addSource(input, opts);
      this.list = [...this.list.filter((x) => x.id !== s.id), s];
      toasts.push({ message: `Added ${s.title ?? s.ytId}`, kind: 'success', timeoutMs: 3500 });
      return s;
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not add source');
      return null;
    }
  }
  async patch(id: number, patch: Partial<Pick<SourceDTO, 'enabled' | 'isOwn' | 'title' | 'importMode'>>) {
    const prev = this.list;
    this.list = this.list.map((s) => (s.id === id ? { ...s, ...patch } : s));
    try {
      const s = await api.patchSource(id, patch);
      this.list = this.list.map((x) => (x.id === id ? s : x));
    } catch (e) {
      this.list = prev;
      toasts.error(e instanceof Error ? e.message : 'Could not update source');
    }
  }
  async remove(id: number, purge: boolean) {
    const prev = this.list;
    this.list = this.list.filter((s) => s.id !== id);
    try {
      await api.deleteSource(id, purge);
    } catch (e) {
      this.list = prev;
      toasts.error(e instanceof Error ? e.message : 'Could not remove source');
    }
  }
}

export const sources = new SourcesStore();
