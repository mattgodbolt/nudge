import { describe, expect, it } from 'vitest';
import type { ItemDTO } from '../../../shared/types';
import { authorChip, reasonChip, refLabel, statusChip } from './github';

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
