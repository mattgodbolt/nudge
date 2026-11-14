import type { SuggestStatusDTO } from '../../../../shared/types';

/** How far the background suggestion worker has got; set from the bootstrap and kept current by the event stream. */
class SuggestStatusStore {
  value = $state<SuggestStatusDTO | null>(null);
  set(v: SuggestStatusDTO | null | undefined) {
    this.value = v ?? null;
  }
}

export const suggestStatus = new SuggestStatusStore();
