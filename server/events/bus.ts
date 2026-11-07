import type { ServerEvent } from '../../shared/types.js';
import type { EventBus } from '../contracts.js';

export function createEventBus(): EventBus {
  const subscribers = new Set<(e: ServerEvent) => void>();
  return {
    emit(e) {
      // Copy so a subscriber unsubscribing mid-emit can't disturb iteration; one bad
      // subscriber (e.g. a dead socket) must not stop the others.
      for (const fn of [...subscribers]) {
        try {
          fn(e);
        } catch (err) {
          console.error('event subscriber failed', err);
        }
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
