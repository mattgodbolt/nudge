import type { Truth } from './truth.js';
import { VERDICTS } from './types.js';
import type { Verdict } from './types.js';

export interface Scored {
  id: string;
  truth: Truth;
  predicted: Verdict;
  confidence: 'low' | 'medium' | 'high';
}

export interface Report {
  n: number;
  /** matrix[truth][predicted] */
  matrix: Record<Verdict, Record<Verdict, number>>;
  /** Of everything the owner needed to reply to, how much was kept: the number that must be high. */
  needsReplyRecall: number | null;
  /** Of everything called "no reply needed", how much really was: the cost of a chip that lies. */
  noReplyPrecision: number | null;
  spamPrecision: number | null;
  /** Wrong calls that would have hidden something that needed a reply. */
  dangerous: string[];
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function score(rows: Scored[]): Report {
  const matrix = Object.fromEntries(
    VERDICTS.map((t) => [t, Object.fromEntries(VERDICTS.map((p) => [p, 0]))]),
  ) as Report['matrix'];
  const dangerous: string[] = [];
  for (const r of rows) {
    matrix[r.truth.verdict][r.predicted]++;
    const wanted = r.truth.verdict === 'needs_reply' || r.truth.verdict === 'needs_action';
    if (wanted && (r.predicted === 'no_reply_needed' || r.predicted === 'spam')) dangerous.push(r.id);
  }
  const col = (p: Verdict) => VERDICTS.reduce((s, t) => s + matrix[t][p], 0);
  const row = (t: Verdict) => VERDICTS.reduce((s, p) => s + matrix[t][p], 0);
  return {
    n: rows.length,
    matrix,
    needsReplyRecall: ratio(matrix.needs_reply.needs_reply, row('needs_reply')),
    noReplyPrecision: ratio(matrix.no_reply_needed.no_reply_needed, col('no_reply_needed')),
    spamPrecision: ratio(matrix.spam.spam, col('spam')),
    dangerous,
  };
}
