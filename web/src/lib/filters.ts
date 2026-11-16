import type { SuggestionFilter } from '../../../shared/api';
import { isSuggestionFilter } from './suggestions';

/**
 * The one definition of what the list can be filtered by. The URL holds the filters (under the short names in
 * FILTER_QUERY_KEYS); the inbox store, the empty states and the "clear filters" key and button all read them from
 * here, so adding a filter in one place cannot leave the others behind.
 */
export interface InboxFilters {
  sourceId?: number;
  videoId?: string;
  feedId?: number;
  repo?: string;
  kind?: 'pr' | 'issue' | 'todo';
  audience?: Audience;
  /** Only items with this current suggestion (or, 'none', no suggestion yet). */
  suggestion?: SuggestionFilter;
  q?: string;
}

export const AUDIENCES = ['outside', 'team', 'contributors', 'bots', 'people'] as const;
export type Audience = (typeof AUDIENCES)[number];
const KINDS = ['pr', 'issue', 'todo'] as const;

/** URL query keys that are filters. `c` (the selected item) is not one. */
export const FILTER_QUERY_KEYS = ['source', 'video', 'feed', 'repo', 'kind', 'who', 'sug', 'q'] as const;
/** Filter fields other than the search text. */
export const FILTER_KEYS = ['sourceId', 'videoId', 'feedId', 'repo', 'kind', 'audience', 'suggestion'] as const;

const id = (v: string | undefined): number | undefined => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export function filtersFromQuery(query: Record<string, string | undefined>): InboxFilters {
  const f: InboxFilters = {
    sourceId: id(query.source),
    videoId: query.video || undefined,
    feedId: id(query.feed),
    repo: query.repo || undefined,
    kind: KINDS.find((k) => k === query.kind),
    audience: AUDIENCES.find((a) => a === query.who),
    suggestion: isSuggestionFilter(query.sug) ? query.sug : undefined,
    q: query.q || undefined,
  };
  for (const k of Object.keys(f) as (keyof InboxFilters)[]) if (f[k] === undefined) delete f[k];
  return f;
}

export function hasFilters(f: InboxFilters): boolean {
  return FILTER_KEYS.some((k) => f[k] !== undefined) || !!f.q;
}

export function sameFilters(a: InboxFilters, b: InboxFilters): boolean {
  return FILTER_KEYS.every((k) => a[k] === b[k]) && (a.q ?? '') === (b.q ?? '');
}

/** A query patch that removes every filter (and the selection, which belonged to the filtered list). */
export function clearedQuery(): Record<(typeof FILTER_QUERY_KEYS)[number] | 'c', undefined> {
  return Object.fromEntries([...FILTER_QUERY_KEYS, 'c'].map((k) => [k, undefined])) as Record<
    (typeof FILTER_QUERY_KEYS)[number] | 'c',
    undefined
  >;
}
