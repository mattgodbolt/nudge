// Phase 0 of LLM triage (issues #9, #10). Offline only: nothing here is wired into the running server.

/** One exported item (see scripts/triage-eval/export.mjs). */
export interface EvalItem {
  id: string;
  provider: 'youtube' | 'github';
  kind: string;
  container: string;
  title: string | null;
  author: string | null;
  text: string;
  occurredAt: string;
  state: string;
  stateSource: string;
  /** YouTube: the channel the video is on, and whether it is one of the owner's own channels. */
  channel?: string | null;
  ownChannel?: boolean;
  /**
   * Context that is not the text: author history up to this item, likes, video age and views. Exported, but NOT shown
   * to the classifier: shown as a <context> hint it left recall unchanged and lowered no-reply precision (82.4% and
   * 87.3% to 81.8% on the dev half). Kept as raw material for the priority work (#27).
   */
  meta?: {
    authorPriorComments?: number;
    authorPriorAnswered?: number;
    authorPriorItems?: number;
    likes?: number;
    videoAgeDays?: number | null;
    videoViews?: number | null;
  };
  isReply?: boolean;
  thread?: { own: boolean; text: string }[];
  /** Ground truth, never classifier input: the channel's later answer in the same thread. */
  ownReply?: string | null;
  github?: {
    association: string | null;
    authorType: string | null;
    labels: string[];
    comments: number;
    draft: boolean;
    sourceState: string | null;
    reason: string | null;
  };
}

/**
 * What the owner needs to do about it. Deliberately coarse: this is the thing worth measuring. `needs_action` is for
 * things to merge, review or decide on that nobody is waiting for a written answer to (bot PRs, release PRs).
 */
export const VERDICTS = ['needs_reply', 'needs_action', 'no_reply_needed', 'spam'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Labels agreed with the owner after the first hand-labelled run (praise and banter merged: he treats them alike). The model must pick one (or "other"); it can never invent one.
 * `bot` is rules-only territory for GitHub but is a valid answer so the model can agree with the rules.
 */
export const CATEGORIES = ['question', 'technical', 'bug', 'idea', 'chat', 'support', 'bot', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface Classification {
  verdict: Verdict;
  category: Category;
  confidence: Confidence;
  /** One short sentence, URLs stripped, clamped. Rendered as text only. */
  reason: string;
  /** The comment tried to instruct the classifier. A strong spam signal in itself. */
  injectionAttempt: boolean;
}

export interface Usage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}
