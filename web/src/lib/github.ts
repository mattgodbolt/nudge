import type { GithubDiscussionEntry, ItemDTO } from '../../../shared/types';

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
  if (item.reason === 'new_activity') {
    const who = item.github?.lastCommenter;
    return who
      ? { text: `New comment from @${who}`, tone: 'accent', title: `${who} commented` }
      : { text: 'New activity', tone: 'accent', title: 'Someone commented' };
  }
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

/** Is this entry newer than what the owner had seen? No cut-off known (or unparseable) means nothing is marked. */
export function isNewEntry(entry: GithubDiscussionEntry, since: string | null | undefined): boolean {
  if (!since) return false;
  const s = Date.parse(since);
  return Number.isFinite(s) && Date.parse(entry.createdAt) > s;
}

const REVIEW_BADGES: Record<NonNullable<GithubDiscussionEntry['reviewState']>, Chip> = {
  approved: { text: 'Approved', tone: 'neutral', title: 'Approved the changes' },
  changes_requested: { text: 'Changes requested', tone: 'accent', title: 'Asked for changes' },
  commented: { text: 'Reviewed', tone: 'muted', title: 'Left review comments' },
  dismissed: { text: 'Dismissed review', tone: 'muted', title: 'This review was dismissed' },
};
export const reviewBadge = (entry: GithubDiscussionEntry): Chip | null =>
  entry.reviewState ? REVIEW_BADGES[entry.reviewState] : null;

/** "src/a.ts:42" for an inline comment; just the path once the line is outdated. */
export const inlineContext = (entry: GithubDiscussionEntry): string | null =>
  entry.path ? `${entry.path}${entry.line ? `:${entry.line}` : ''}` : null;

/** Short chip for who someone is to the repo; only the ones worth a glance (outsiders, first-timers, bots). */
export function entryChip(entry: GithubDiscussionEntry): Chip | null {
  if (entry.authorType === 'Bot') return { text: 'Bot', tone: 'muted', title: 'A bot' };
  switch (entry.association) {
    case 'FIRST_TIME_CONTRIBUTOR':
    case 'FIRST_TIMER':
      return { text: 'First time', tone: 'accent', title: 'Their first contribution here' };
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
