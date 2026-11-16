import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/sw.js is plain script, not a module, so it runs here in a sandbox with a fake `self`.
const SOURCE = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://nudge.example.com';

function loadWorker() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: { data: { url: string } } }[] = [];
  const opened: string[] = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: { data: { url: string } }) =>
        void shown.push({ title, options }),
      getNotifications: async () => [],
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  runInNewContext(SOURCE, { self, URL });
  const run = async (type: string, event: object) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  return {
    shown,
    opened,
    push: (data: unknown) => run('push', { data: { json: () => data, text: () => JSON.stringify(data) } }),
    click: (url: unknown) => run('notificationclick', { notification: { close: () => undefined, data: { url } } }),
  };
}

describe('service worker notification links', () => {
  it('keeps an in-app path, with its query', async () => {
    const w = loadWorker();
    await w.push({ title: 't', url: '/inbox?c=gh%3Ao%2Fr%231' });
    expect(w.shown[0]!.options.data.url).toBe('/inbox?c=gh%3Ao%2Fr%231');
    await w.click('/inbox?c=x');
    expect(w.opened).toEqual(['/inbox?c=x']);
  });

  it('never opens another site, however the push spells it', async () => {
    for (const url of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', 7]) {
      const w = loadWorker();
      await w.push({ title: 't', url });
      expect(w.shown[0]!.options.data.url, String(url)).toBe('/inbox');
      await w.click(url);
      expect(w.opened, String(url)).toEqual(['/inbox']);
    }
  });
});
