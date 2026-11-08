import type { ItemDTO } from '../../../shared/types';

export interface Chip {
  text: string;
  /** 'accent' draws the eye (someone new), 'muted' stays in the background. */
  tone: 'accent' | 'neutral' | 'muted';
  title: string;
}

/** What GitHub knows about the relationship between a PR/issue author and the repository, as a short chip. */
export function authorChip(item: ItemDTO): Chip | null {
  const g = item.github;
  if (!g) return null;
  if (g.authorType === 'Bot') return { text: 'Bot', tone: 'muted', title: 'Opened by a bot' };
  const noun = item.kind === 'issue' ? 'issue' : 'pull request';
  switch (g.association) {
    case 'FIRST_TIME_CONTRIBUTOR':
    case 'FIRST_TIMER':
      return { text: 'First time', tone: 'accent', title: `Their first ${noun} here` };
    case 'NONE':
    case 'MANNEQUIN':
      return { text: 'Outside', tone: 'accent', title: 'Not a member and has not contributed here before' };
    case 'CONTRIBUTOR':
      return { text: 'Contributor', tone: 'neutral', title: 'Has contributed here before' };
    case 'OWNER':
    case 'MEMBER':
    case 'COLLABORATOR':
      return { text: 'Team', tone: 'muted', title: 'Member or collaborator' };
    default:
      return null;
  }
}

/** Reasons an item is back in the inbox, worth saying out loud. */
export function reasonChip(item: ItemDTO): Chip | null {
  if (item.reason === 'new_activity') return { text: 'New activity', tone: 'accent', title: 'Someone commented' };
  if (item.reason === 'reopened') return { text: 'Reopened', tone: 'accent', title: 'Reopened on GitHub' };
  return null;
}

/** Closed or merged at the source, drafts, and so on: the item's own status chip. */
export function statusChip(item: ItemDTO): Chip | null {
  if (item.sourceState === 'merged') return { text: 'Merged', tone: 'muted', title: 'Merged on GitHub' };
  if (item.sourceState === 'closed') return { text: 'Closed', tone: 'muted', title: 'Closed on GitHub' };
  if (item.github?.draft) return { text: 'Draft', tone: 'muted', title: 'Draft pull request' };
  return null;
}

/** "org/app #123" */
export function refLabel(item: ItemDTO): string {
  return `${item.containerTitle ?? ''}${item.github ? ` #${item.github.number}` : ''}`;
}
