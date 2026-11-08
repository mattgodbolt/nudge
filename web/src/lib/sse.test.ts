import { describe, expect, it } from 'vitest';
import { dispatch } from './sse';
import { inbox } from './stores/inbox.svelte';
import { labels } from './stores/labels.svelte';
import { settings } from './stores/settings.svelte';

describe('sse dispatch', () => {
  it('capabilities.changed updates the capabilities store', () => {
    settings.capabilities = { canPost: false, postMode: 'handoff' };
    dispatch({
      type: 'capabilities.changed',
      capabilities: { canPost: true, postMode: 'api', postAs: { channelId: 'UC1', title: 'Me' } },
    });
    expect(settings.capabilities.postMode).toBe('api');
    expect(settings.capabilities.postAs?.title).toBe('Me');
  });

  it('labels.changed replaces the label list', () => {
    labels.set([]);
    dispatch({
      type: 'labels.changed',
      labels: [
        { id: 2, name: 'B', color: 'red', position: 1 },
        { id: 1, name: 'A', color: 'blue', position: 0 },
      ],
    });
    expect(labels.list.map((l) => l.name)).toEqual(['A', 'B']);
  });

  it('labels.changed prunes label ids that no longer exist from the inbox', () => {
    inbox.counts = { ...inbox.counts, byLabel: { 1: 3, 2: 1 } };
    dispatch({ type: 'labels.changed', labels: [{ id: 1, name: 'A', color: 'blue', position: 0 }] });
    expect(inbox.counts.byLabel).toEqual({ 1: 3 });
  });

  it('inbox.changed updates counts including snoozed and byLabel', () => {
    const counts = {
      inbox: 1,
      done: 0,
      all: 2,
      snoozed: 1,
      bySource: {},
      byLabel: { 1: 1 },
      byFeed: {},
      byRepo: {},
      todos: 0,
    };
    dispatch({ type: 'inbox.changed', counts, addedIds: [], changedIds: [] });
    expect(inbox.counts.snoozed).toBe(1);
    expect(inbox.counts.byLabel).toEqual({ 1: 1 });
  });
});
