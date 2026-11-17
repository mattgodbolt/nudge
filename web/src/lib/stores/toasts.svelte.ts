export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
  timeoutMs: number;
}

class ToastStore {
  items = $state<Toast[]>([]);
  #next = 1;
  #timers = new Map<number, ReturnType<typeof setTimeout>>();

  push(t: { message: string; kind?: Toast['kind']; action?: Toast['action']; timeoutMs?: number }): number {
    const toast: Toast = {
      id: this.#next++,
      message: t.message,
      kind: t.kind ?? 'info',
      action: t.action,
      timeoutMs: t.timeoutMs ?? 6000,
    };
    this.items = [...this.items.slice(-3), toast];
    if (toast.timeoutMs > 0)
      this.#timers.set(
        toast.id,
        setTimeout(() => this.dismiss(toast.id), toast.timeoutMs),
      );
    return toast.id;
  }

  error(message: string) {
    return this.push({ message, kind: 'error', timeoutMs: 8000 });
  }

  /** An error toast for a caught value: its message when it is an Error, otherwise the fallback. */
  fail(e: unknown, fallback: string) {
    return this.error(e instanceof Error ? e.message : fallback);
  }

  success(message: string, timeoutMs?: number) {
    return this.push({ message, kind: 'success', timeoutMs });
  }

  dismiss(id: number) {
    const t = this.#timers.get(id);
    if (t) clearTimeout(t);
    this.#timers.delete(id);
    this.items = this.items.filter((x) => x.id !== id);
  }
}

export const toasts = new ToastStore();
