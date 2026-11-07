import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabelDTO } from '../../../../shared/types';
import { labels } from './labels.svelte';
import { toasts } from './toasts.svelte';

const l = (id: number, name: string, position: number): LabelDTO => ({ id, name, color: 'blue', position });
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('labels store', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    toasts.items = [];
    labels.set([l(2, 'Beta', 1), l(1, 'Alpha', 0)]);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps labels sorted by position', () => {
    expect(labels.list.map((x) => x.name)).toEqual(['Alpha', 'Beta']);
  });

  it('resolves comment label ids in sidebar order and skips unknown ids', () => {
    expect(labels.resolve([2, 99, 1]).map((x) => x.name)).toEqual(['Alpha', 'Beta']);
  });

  it('creates a label and adds it to the list', async () => {
    fetchMock.mockReturnValue(json({ id: 3, name: 'Gamma', color: 'red', position: 2 }, 201));
    expect((await labels.create('Gamma', 'red'))?.id).toBe(3);
    expect(labels.list.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ name: 'Gamma', color: 'red' });
  });

  it('toasts the server message when creation fails', async () => {
    fetchMock.mockReturnValue(json({ error: 'Label already exists', code: 'duplicate_label' }, 409));
    expect(await labels.create('alpha')).toBeNull();
    expect(toasts.items.at(-1)).toMatchObject({ kind: 'error', message: 'Label already exists' });
  });

  it('renames optimistically and rolls back on failure', async () => {
    fetchMock.mockReturnValue(json({ error: 'nope', code: 'bad_name' }, 400));
    const p = labels.patch(1, { name: 'Renamed' });
    expect(labels.get(1)!.name).toBe('Renamed');
    expect(await p).toBe(false);
    expect(labels.get(1)!.name).toBe('Alpha');
  });

  it('moves a label by swapping positions', async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) =>
      json({ id: 0, name: '', color: 'blue', position: 0, ...JSON.parse(init.body as string) }),
    );
    await labels.move(2, -1);
    expect(labels.list.map((x) => x.id)).toEqual([2, 1]);
    const patches = fetchMock.mock.calls.map((c) => [c[0], JSON.parse(c[1].body)]);
    expect(patches).toEqual(
      expect.arrayContaining([
        ['/api/labels/2', { position: 0 }],
        ['/api/labels/1', { position: 1 }],
      ]),
    );
  });

  it('does not move past the ends', async () => {
    await labels.move(1, -1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes a label, restoring it if the delete fails', async () => {
    fetchMock.mockReturnValue(Promise.resolve(new Response(null, { status: 204 })));
    expect(await labels.remove(1)).toBe(true);
    expect(labels.list.map((x) => x.id)).toEqual([2]);
    fetchMock.mockReturnValue(json({ error: 'x', code: 'internal' }, 500));
    expect(await labels.remove(2)).toBe(false);
    expect(labels.list.map((x) => x.id)).toEqual([2]);
  });
});
