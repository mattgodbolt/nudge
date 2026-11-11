import { describe, expect, it } from 'vitest';
import type { ItemDTO } from '../../../shared/types';
import type { GithubDiscussionEntry } from '../../../shared/types';
import {
  authorChip,
  entryChip,
  inlineContext,
  isNewEntry,
  reasonChip,
  refLabel,
  reviewBadge,
  statusChip,
} from './github';

const gh = (over: Partial<NonNullable<ItemDTO['github']>> = {}, top: Partial<ItemDTO> = {}): ItemDTO => ({
  id: 'gh:org/app#1',
  provider: 'github',
  kind: 'pr',
  title: 'T',
  author: 'a',
  authorAvatarUrl: null,
  isOwn: false,
  url: 'u',
  containerKey: 'org/app',
  containerTitle: 'org/app',
  containerUrl: 'c',
  sourceState: 'open',
  reason: 'new',
  muted: false,
  github: {
    owner: 'org',
    repo: 'app',
    number: 1,
    draft: false,
    association: 'CONTRIBUTOR',
    authorType: 'User',
    comments: 0,
    labels: [],
    createdAt: 'x',
    ...over,
  },
  ...top,
});

describe('authorChip', () => {
  it('says who opened it, with outsiders and first-timers standing out', () => {
    expect(authorChip(gh({ association: 'FIRST_TIME_CONTRIBUTOR' }))).toMatchObject({
      text: 'First time',
      tone: 'accent',
    });
    expect(authorChip(gh({ association: 'NONE' }))).toMatchObject({ text: 'Outside', tone: 'accent' });
    expect(authorChip(gh({ association: 'CONTRIBUTOR' }))).toMatchObject({ text: 'Contributor', tone: 'neutral' });
    expect(authorChip(gh({ association: 'MEMBER' }))).toMatchObject({ text: 'Team', tone: 'muted' });
    expect(authorChip(gh({ association: null }))).toBeNull();
  });
  it('a bot is a bot whatever its association', () => {
    expect(authorChip(gh({ authorType: 'Bot', association: 'NONE' }))).toMatchObject({ text: 'Bot', tone: 'muted' });
  });
  it('names the thing in the tooltip', () => {
    expect(authorChip(gh({ association: 'FIRST_TIMER' }, { kind: 'issue' }))?.title).toContain('issue');
  });
  it('is null for YouTube items', () => {
    expect(authorChip({ ...gh(), github: undefined, provider: 'youtube' })).toBeNull();
  });
});

describe('reasonChip / statusChip / refLabel', () => {
  it('flags activity and reopened, not plain new arrivals', () => {
    expect(reasonChip(gh({}, { reason: 'new_activity' }))?.text).toBe('New activity');
    expect(reasonChip(gh({}, { reason: 'reopened' }))?.text).toBe('Reopened');
    expect(reasonChip(gh({}, { reason: 'new' }))).toBeNull();
  });
  it('shows closed, merged and draft', () => {
    expect(statusChip(gh({}, { sourceState: 'merged' }))?.text).toBe('Merged');
    expect(statusChip(gh({}, { sourceState: 'closed' }))?.text).toBe('Closed');
    expect(statusChip(gh({ draft: true }))?.text).toBe('Draft');
    expect(statusChip(gh())).toBeNull();
  });
  it('builds "owner/repo #n"', () => {
    expect(refLabel(gh({ number: 42 }))).toBe('org/app #42');
  });
});

describe('reasonChip with a known commenter', () => {
  it('names who commented', () => {
    expect(reasonChip(gh({ lastCommenter: 'dave' }, { reason: 'new_activity' }))?.text).toBe('New comment from @dave');
    expect(reasonChip(gh({ lastCommenter: null }, { reason: 'new_activity' }))?.text).toBe('New activity');
  });
});

const entry = (over: Partial<GithubDiscussionEntry> = {}): GithubDiscussionEntry => ({
  id: 'c1',
  kind: 'comment',
  author: 'erin',
  avatarUrl: null,
  authorType: 'User',
  association: null,
  createdAt: '2026-11-02T00:00:00.000Z',
  body: '',
  url: null,
  ...over,
});

describe('discussion helpers', () => {
  it('marks only entries after the cut-off, and nothing without one', () => {
    expect(isNewEntry(entry(), '2026-11-01T00:00:00.000Z')).toBe(true);
    expect(isNewEntry(entry(), '2026-11-03T00:00:00.000Z')).toBe(false);
    expect(isNewEntry(entry(), null)).toBe(false);
    expect(isNewEntry(entry(), 'garbage')).toBe(false);
  });
  it('badges reviews and describes inline context', () => {
    expect(reviewBadge(entry({ reviewState: 'changes_requested' }))?.text).toBe('Changes requested');
    expect(reviewBadge(entry())).toBeNull();
    expect(inlineContext(entry({ path: 'a/b.ts', line: 3 }))).toBe('a/b.ts:3');
    expect(inlineContext(entry({ path: 'a/b.ts', line: null }))).toBe('a/b.ts');
    expect(inlineContext(entry())).toBeNull();
  });
  it('chips bots and outsiders', () => {
    expect(entryChip(entry({ authorType: 'Bot' }))?.text).toBe('Bot');
    expect(entryChip(entry({ association: 'NONE' }))?.text).toBe('Outside');
    expect(entryChip(entry())).toBeNull();
  });
});
