import { describe, expect, it } from 'vitest';
import { applyRules } from './rules.js';
import type { EvalItem } from './types.js';

const yt = (text: string): EvalItem => ({
  id: 'x',
  provider: 'youtube',
  kind: 'comment',
  container: 'v',
  title: null,
  author: '@a',
  text,
  occurredAt: '2026-01-01T00:00:00Z',
  state: 'archived',
  stateSource: 'sync',
});
const gh = (authorType: string | null, author = 'someone'): EvalItem => ({
  ...yt('Bump x from 1 to 2'),
  provider: 'github',
  kind: 'pr',
  author,
  github: {
    association: 'NONE',
    authorType,
    labels: [],
    comments: 0,
    draft: false,
    sourceState: 'open',
    reason: 'new',
  },
});

describe('applyRules', () => {
  it.each(['👍', '😂😂😂', '!!!', '', '1', '❤️❤️'])('%j has no words, so no reply is needed', (t) => {
    expect(applyRules(yt(t))?.verdict).toBe('no_reply_needed');
  });
  it.each(['你好世界这是一个很长的评论', '🔥🚀💯👏😂🙌❤️🎉'])('%j is not symbol soup', (t) => {
    expect(applyRules(yt(t))?.rule).not.toBe('symbol-soup');
  });
  it.each(['Great video!', 'Thanks!', 'Incredible talk!'])(
    '%j is left for the model: the owner often answers warm praise',
    (t) => {
      expect(applyRules(yt(t))).toBeNull();
    },
  );
  it.each(['⺟⫸⎵ⶒ⧏⅔⩌⪼⠣❥⥌⃯⹒✽⡕ⶴ➴⳰►⾁⃫⠫⬪’⊲⎅'])('%j is symbol soup, so spam', (t) => {
    expect(applyRules(yt(t))).toMatchObject({ verdict: 'spam', rule: 'symbol-soup' });
  });
  it.each(['Great video, but why is -O3 slower here?', 'Thanks! Is the code available?', 'cool?'])(
    'a question mark always defers to the model: %j',
    (t) => expect(applyRules(yt(t))).toBeNull(),
  );
  it('does not call a long substantive comment praise', () => {
    expect(applyRules(yt('Great explanation, though at 11:14 you said mutex but showed a semaphore'))).toBeNull();
  });
  it('flags off-platform contact as low-confidence spam, never higher', () => {
    expect(applyRules(yt('DM me on Telegram for guaranteed returns'))).toMatchObject({
      verdict: 'spam',
      confidence: 'low',
    });
  });
  it('does not treat cryptography as crypto', () => {
    expect(applyRules(yt('Interesting overview of cryptography in compilers'))).toBeNull();
  });
  it('never decides needs_reply', () => {
    for (const t of ['Why?', 'You are wrong about X', 'Bug: it crashes']) {
      expect(applyRules(yt(t))?.verdict).not.toBe('needs_reply');
    }
  });
  it('sends bot PRs to needs_action, tiny ghost items to spam, and leaves humans undecided', () => {
    expect(applyRules(gh('Bot', 'dependabot[bot]'))).toMatchObject({
      verdict: 'needs_action',
      category: 'bot',
      confidence: 'high',
    });
    expect(applyRules({ ...gh('User', 'ghost'), text: 'removed' })?.verdict).toBe('spam');
    expect(applyRules(gh('User', 'alice'))).toBeNull();
  });
});
