import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RpgSheet } from '../../shared/types.js';
import { levelForXp, titleFor, xpForLevel } from '../../shared/rpg.js';
import { openDb, type Db } from './db.js';
import { createRepo } from './repo.js';
import {
  ANCIENT_ONE_MIN_INBOX,
  CAMPFIRE,
  XP,
  campDays,
  campfire,
  createRpgReader,
  dayCounter,
  planClaim,
  rpgSheet,
  weekday,
} from './rpg.js';

// Monday 2 November 2026, noon UTC, is day 0 of these fixtures.
const BASE = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (day: number, hour = 0) => new Date(BASE + day * DAY + hour * HOUR).toISOString();

interface ItemOpts {
  provider?: 'youtube' | 'github' | 'todo';
  kind?: string;
  /** Days before day 0 the thing was written (its age). */
  ageDays?: number;
  /** Day it arrived in Nudge. */
  seenDay?: number;
  state?: string;
  data?: Record<string, unknown>;
  snoozedUntil?: string | null;
}

function world() {
  const db = openDb(':memory:');
  let nextEvent = 1;
  let nextAction = 1000;
  const item = (id: string, o: ItemOpts = {}) => {
    const provider = o.provider ?? 'github';
    const seen = at(o.seenDay ?? -1);
    db.prepare(
      `INSERT INTO items (id, provider, kind, title, occurred_at, state, state_source, state_changed_at, first_seen_at,
                          data, snoozed_until)
       VALUES (?, ?, ?, 'x', ?, ?, 'sync', ?, ?, ?, ?)`,
    ).run(
      id,
      provider,
      o.kind ?? (provider === 'todo' ? 'todo' : provider === 'youtube' ? 'comment' : 'pr'),
      new Date(BASE - (o.ageDays ?? 1) * DAY).toISOString(),
      o.state ?? 'inbox',
      seen,
      seen,
      o.data ? JSON.stringify(o.data) : null,
      o.snoozedUntil ?? null,
    );
    return id;
  };
  const ev = (
    itemId: string,
    when: string,
    kind: string,
    from: string | null,
    to: string | null,
    source: 'user' | 'auto' | 'sync',
    meta: Record<string, unknown> = {},
  ): number => {
    const id = nextEvent++;
    db.prepare(
      'INSERT INTO item_events (id, item_id, at, kind, from_value, to_value, source, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, itemId, when, kind, from, to, source, JSON.stringify(meta));
    return id;
  };
  /** A one-item user action, as triage writes it. */
  const done = (itemId: string, when: string, reason: 'done' | 'no_action' | null = 'done') => {
    const actionId = nextAction++;
    return {
      actionId,
      eventId: ev(itemId, when, 'state', 'inbox', 'done', 'user', { actionId, ...(reason ? { reason } : {}) }),
    };
  };
  const replied = (itemId: string, when: string) => {
    const actionId = nextAction++;
    return { actionId, eventId: ev(itemId, when, 'state', 'inbox', 'replied', 'user', { actionId }) };
  };
  const undo = (itemId: string, when: string, a: { actionId: number; eventId?: number }, to = 'inbox') =>
    ev(itemId, when, 'undo', 'done', to, 'user', {
      actionId: a.actionId,
      original: 'state',
      ...(a.eventId ? { originalEventId: a.eventId } : {}),
    });
  const snooze = (itemId: string, when: string, until: string, meta: Record<string, unknown> = {}) =>
    ev(itemId, when, 'snooze', null, until, 'user', { actionId: nextAction++, ...meta });
  const wake = (itemId: string, when: string, cause: 'fallback' | 'activity', extra: Record<string, unknown> = {}) =>
    ev(itemId, when, 'snooze', when, null, 'auto', { reason: 'wake', cause, untilActivity: true, ...extra });
  const sheet = (nowDay = 30, tz = 'UTC', extra: { prevTz?: string; now?: string } = {}) =>
    rpgSheet(db, { now: new Date(extra.now ?? at(nowDay)), tz, prevTz: extra.prevTz ?? null });
  return { db, item, ev, done, replied, undo, snooze, wake, sheet, action: () => nextAction++ };
}
const ach = (s: RpgSheet, id: string) => s.achievements.find((a) => a.id === id)!;
const boss = (s: RpgSheet, id: string) => s.bosses.find((b) => b.id === id)!;
const loot = (s: RpgSheet, id: string) => s.loot.find((l) => l.id === id)!;

describe('levels and titles', () => {
  it('follows 100 × (n − 1)² exactly at the thresholds', () => {
    expect([1, 2, 5, 10, 20].map(xpForLevel)).toEqual([0, 100, 1600, 8100, 36100]);
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(1599)).toBe(4);
    expect(levelForXp(1600)).toBe(5);
    expect(levelForXp(36100)).toBe(20);
    for (let l = 1; l < 60; l++) expect(levelForXp(xpForLevel(l))).toBe(l);
  });
  it('names levels, and past 20 starts a new age', () => {
    expect(titleFor(1)).toBe('Inbox Peasant');
    expect(titleFor(7)).toBe('Ranger of the Backlog');
    expect(titleFor(20)).toBe('Benevolent Dictator of the Inbox (For Life)');
    expect(titleFor(21)).toBe('Inbox Peasant of the Second Age');
    expect(titleFor(41)).toBe('Inbox Peasant of the Third Age');
  });
});

describe('XP', () => {
  it('starts an empty database at level 1 with nothing earned', () => {
    const w = world();
    const s = w.sheet();
    expect(s).toMatchObject({ xp: 0, level: 1, levelTitle: 'Inbox Peasant', levelXp: 0, nextLevelXp: 100 });
    expect(s.achievements.every((a) => !a.earned)).toBe(true);
    expect(s.bosses.every((b) => b.defeated === 0)).toBe(true);
    expect(s.today).toEqual({ cloak: false, lantern: false, hat: false, flame: false });
    expect(s.campfire).toMatchObject({ current: 0, longest: 0, notice: null });
    expect(s.tally.payouts).toBe(0);
  });

  it('pays by what was done: reply 10, done 8, todo 5, legacy 4, dismissal 1, snooze 0', () => {
    const w = world();
    // Seen the day before, so there is no patience bonus in these.
    w.done(w.item('gh', { seenDay: 0 }), at(1));
    w.done(w.item('yt', { provider: 'youtube', seenDay: 0 }), at(1));
    w.done(w.item('td', { provider: 'todo', seenDay: 0 }), at(1));
    w.done(w.item('old', { seenDay: 0 }), at(1), null);
    w.done(w.item('dis', { seenDay: 0 }), at(1), 'no_action');
    w.replied(w.item('rep', { provider: 'youtube', seenDay: 0 }), at(1));
    w.snooze(w.item('sn', { seenDay: 0 }), at(1), at(2));
    const s = w.sheet(3);
    expect(s.xp).toBe(XP.done * 2 + XP.todo + XP.legacy + XP.dismiss + XP.reply);
    expect(s.tally).toEqual({ payouts: 6, replies: 1, dones: 4, dismissals: 1 });
  });

  it('pays nothing for what the app or the remote service did', () => {
    const w = world();
    w.ev(w.item('a', { seenDay: 0 }), at(1), 'state', 'inbox', 'resolved', 'sync', { reason: 'closed_upstream' });
    w.ev(w.item('b', { provider: 'youtube', seenDay: 0 }), at(1), 'state', 'inbox', 'auto_replied', 'auto', {
      reason: 'own_reply',
    });
    w.ev(w.item('c', { seenDay: 0 }), at(1), 'state', 'inbox', 'archived', 'user', { actionId: w.action() }); // a mute
    expect(w.sheet(3).xp).toBe(0);
  });

  it('counts a reply made on GitHub (seen by sync) and adds the welcome bonus for a newcomer', () => {
    const w = world();
    w.ev(w.item('a', { seenDay: 0 }), at(1), 'reply', null, null, 'sync', { commenter: 'me' });
    w.ev(
      w.item('b', { seenDay: 0, data: { association: 'FIRST_TIME_CONTRIBUTOR' } }),
      at(1),
      'reply',
      null,
      null,
      'sync',
    );
    expect(w.sheet(3).xp).toBe(XP.reply + XP.reply + XP.welcome);
    expect(loot(w.sheet(3), 'quill').earned).toBe(true);
  });

  it('takes the XP back on undo, matched by event id or by action id for backfilled rows', () => {
    const w = world();
    const a = w.done(w.item('a', { seenDay: 0 }), at(1));
    w.undo('a', at(1, 1), a);
    const b = w.done(w.item('b', { seenDay: 0 }), at(1));
    w.undo('b', at(1, 1), { actionId: b.actionId }); // backfilled: no originalEventId
    const c = w.done(w.item('c', { seenDay: 0 }), at(1));
    expect(w.sheet(3).xp).toBe(XP.done);
    expect(w.sheet(3).tally.payouts).toBe(1);
    w.undo('c', at(2), c);
    expect(w.sheet(3).xp).toBe(0);
    expect(loot(w.sheet(3), 'ring')).toMatchObject({ earned: true, times: 3 });
  });

  it('cancels an app-posted reply (state and reply events of one action) together on undo', () => {
    const w = world();
    const id = w.item('a', { provider: 'youtube', seenDay: 0 });
    const r = w.replied(id, at(1));
    w.ev(id, at(1), 'reply', null, null, 'user', { actionId: r.actionId });
    expect(w.sheet(3).xp).toBe(XP.reply);
    w.undo(id, at(1, 1), r, 'inbox');
    expect(w.sheet(3).xp).toBe(0);
  });

  it('pays each item once, for its best resolution, and keeps it when the item comes back', () => {
    const w = world();
    const id = w.item('a', { seenDay: 0 });
    w.done(id, at(1));
    // Reopened upstream, then done again: still one payout.
    w.ev(id, at(2), 'state', 'done', 'inbox', 'sync', { reason: 'reopened' });
    w.done(id, at(3));
    expect(w.sheet(4).xp).toBe(XP.done);
    // New activity brings it back and it stays in the inbox: nothing is taken away.
    w.ev(id, at(4), 'state', 'done', 'inbox', 'sync', { reason: 'new_activity' });
    expect(w.sheet(5).xp).toBe(XP.done);
    // A later reply is worth more, so the item now pays the reply rate (still once).
    w.replied(id, at(5));
    expect(w.sheet(6)).toMatchObject({ xp: XP.reply, tally: { payouts: 1, replies: 1 } });
  });

  it('pays the token rate for a bulk action, with no bonuses even on old items', () => {
    const w = world();
    const actionId = w.action();
    for (const id of ['a', 'b', 'c']) {
      w.item(id, { seenDay: -200, ageDays: 400 });
      w.ev(id, at(1), 'state', 'inbox', 'done', 'user', { actionId, reason: 'done' });
    }
    const s = w.sheet(3);
    expect(s.xp).toBe(3 * XP.bulk);
    // Bulk actions are not "dealing with" an item: no bosses.
    expect(boss(s, 'elder_wyrm').defeated).toBe(0);
  });

  it('adds patience for weeks waited, up to the cap, but never on a dismissal', () => {
    const w = world();
    w.done(w.item('a', { seenDay: -21 }), at(1)); // 3 full weeks
    w.done(w.item('b', { seenDay: -400 }), at(1)); // capped
    w.done(w.item('c', { seenDay: -400 }), at(1), 'no_action');
    expect(w.sheet(3).xp).toBe(XP.done + 3 + XP.done + XP.patienceCap + XP.dismiss);
  });

  it('adds the audit bonus when the next move after a "no activity" wake was done or reply, not a re-snooze', () => {
    const w = world();
    const a = w.item('a', { seenDay: 0 });
    w.snooze(a, at(0, 1), at(1));
    w.wake(a, at(1), 'fallback');
    w.done(a, at(1, 1));
    const b = w.item('b', { seenDay: 0 });
    w.snooze(b, at(0, 1), at(1));
    w.wake(b, at(1), 'fallback');
    w.snooze(b, at(1, 1), at(2));
    w.done(b, at(2, 1));
    expect(w.sheet(3).xp).toBe(XP.done + XP.audit + XP.done);
  });

  it('levels up, and puts the wizard hat on for the day it happened only', () => {
    const w = world();
    for (let i = 0; i < 13; i++) w.done(w.item(`i${i}`, { seenDay: 0 }), at(1, i / 10)); // 104 XP
    expect(w.sheet(1)).toMatchObject({ level: 2, today: { hat: true } });
    expect(w.sheet(2).today.hat).toBe(false);
    expect(loot(w.sheet(2), 'hat').times).toBe(1);
  });

  it('logs a worthless find on every 20th payout, chosen by the item id', () => {
    const w = world();
    for (let i = 0; i < 41; i++) w.done(w.item(`i${i}`, { seenDay: 0 }), at(1, i / 100), 'no_action');
    const s = w.sheet(3);
    expect(s.lootLog).toHaveLength(2);
    expect(w.sheet(3).lootLog).toEqual(s.lootLog);
  });
});

describe('inbox replay', () => {
  it('finds the days the inbox reached zero, and follows snoozes running out', () => {
    const w = world();
    const a = w.item('a', { seenDay: 0 });
    const b = w.item('b', { seenDay: 0 });
    w.done(a, at(1));
    // b is snoozed until day 3, then woken by the waker a little later: the inbox is empty from day 1 to day 3.
    w.snooze(b, at(1, 1), at(3));
    w.ev(b, at(3, 2), 'snooze', at(3), null, 'auto', { reason: 'wake' });
    w.done(b, at(5));
    const s = w.sheet(6);
    expect(ach(s, 'inbox_zero')).toMatchObject({ earned: true, earnedOn: '2026-11-03' });
    // Zero on days 1, 2, 3 (until noon), then from day 5 to now (day 6): 5 days.
    expect(ach(s, 'zero_hero').progress).toEqual({ n: 5, of: 7 });
    expect(s.today.cloak).toBe(true);
  });

  it('agrees with the real repository: arrivals, triage, undo and snoozes end at the same inbox count', () => {
    let now = BASE;
    const db = openDb(':memory:');
    const repo = createRepo(db, () => new Date(now));
    const ids = Array.from({ length: 6 }, (_, i) => repo.addTodo({ title: `t${i}`, notes: '', raw: '', dueAt: null }));
    now += HOUR;
    const r1 = repo.triage([ids[0]!], 'done');
    repo.triage([ids[1]!, ids[2]!], 'done'); // bulk
    repo.undo(r1.actionId);
    repo.snooze([ids[3]!], new Date(now + 2 * HOUR).toISOString());
    repo.triage([ids[4]!], 'done', 'no_action');
    now += HOUR;
    const sheet = () => rpgSheet(db, { now: new Date(now), tz: 'UTC' });
    expect(sheet().xp).toBe(2 * XP.bulk + XP.dismiss);
    expect(repo.counts().inbox).toBe(2); // ids 0 and 5; 3 is snoozed
    // Finish everything: the replay must see the inbox at zero once the snooze has run out and been dealt with.
    now += 3 * HOUR;
    repo.wakeSnoozed();
    repo.triage([ids[0]!, ids[3]!, ids[5]!], 'done');
    now += HOUR;
    expect(repo.counts().inbox).toBe(0);
    expect(sheet().today.cloak).toBe(true);
  });

  it('marks Half-Life when the inbox halves from a peak of ten or more', () => {
    const w = world();
    for (let i = 0; i < 10; i++) w.item(`i${i}`, { seenDay: 0 });
    for (let i = 0; i < 4; i++) w.done(`i${i}`, at(1, i));
    expect(ach(w.sheet(2), 'half_life').earned).toBe(false);
    w.done('i4', at(1, 5));
    expect(ach(w.sheet(2), 'half_life').earned).toBe(true);
  });

  it('breaks the backlog when nothing 30 days old is left, and only after there was such a backlog', () => {
    const w = world();
    w.item('young', { seenDay: 0, ageDays: 2 });
    w.done('young', at(1));
    expect(ach(w.sheet(3), 'backlog_breaker').earned).toBe(false);
    w.item('old', { seenDay: 0, ageDays: 40 });
    w.item('other', { seenDay: 0, ageDays: 3 });
    expect(ach(w.sheet(3), 'backlog_breaker').earned).toBe(false);
    w.done('old', at(4));
    expect(ach(w.sheet(5), 'backlog_breaker').earned).toBe(true);
    expect(ach(w.sheet(5), 'ancient_evil').earned).toBe(false);
  });
});

describe('bosses and loot', () => {
  it('fells the Elder Wyrm, the Hydra and the Lich, but never with a dismissal', () => {
    const w = world();
    w.done(w.item('wyrm', { seenDay: 0, ageDays: 400 }), at(1));
    w.replied(w.item('hydra', { seenDay: 0, data: { comments: 25 } }), at(1));
    const lich = w.item('lich', { seenDay: 0 });
    for (const d of [1, 2]) {
      w.snooze(lich, at(d - 1, 1), at(d));
      w.wake(lich, at(d), 'fallback');
    }
    w.done(lich, at(3));
    w.done(w.item('wyrm2', { seenDay: 0, ageDays: 500 }), at(3), 'no_action');
    const s = w.sheet(4);
    expect(boss(s, 'elder_wyrm')).toMatchObject({ defeated: 1, firstOn: '2026-11-03' });
    expect(boss(s, 'hydra').defeated).toBe(1);
    expect(boss(s, 'lich').defeated).toBe(1);
    expect(ach(s, 'archaeologist').earned).toBe(true);
  });

  it(`fells the Ancient One only when the oldest of ${ANCIENT_ONE_MIN_INBOX} or more is dealt with`, () => {
    const w = world();
    for (let i = 0; i < ANCIENT_ONE_MIN_INBOX; i++) w.item(`i${i}`, { seenDay: 0, ageDays: 10 + i });
    w.done('i0', at(1)); // not the oldest
    expect(boss(w.sheet(2), 'ancient_one').defeated).toBe(0);
    w.done(`i${ANCIENT_ONE_MIN_INBOX - 1}`, at(1, 1)); // the oldest, but only 4 left in the inbox
    expect(boss(w.sheet(2), 'ancient_one').defeated).toBe(0);
    w.item('more', { seenDay: 0, ageDays: 1 });
    w.done(`i${ANCIENT_ONE_MIN_INBOX - 2}`, at(1, 2)); // oldest of 5
    expect(boss(w.sheet(2), 'ancient_one').defeated).toBe(1);
  });

  it("hands out the Lantern, the Lute, the Hourglass and the Mimic's Tooth", () => {
    const w = world();
    w.done(w.item('old', { seenDay: 0, ageDays: 100 }), at(30));
    w.replied(w.item('yt', { provider: 'youtube', seenDay: 0, ageDays: 40 }), at(30));
    const h = w.item('h', { seenDay: 0 });
    for (const d of [1, 2, 3]) w.snooze(h, at(d), at(d, 2));
    w.done(h, at(4));
    const m = w.item('m', { seenDay: 0 });
    w.snooze(m, at(5), at(9), { bucket: 'waiting_on_merge', untilActivity: true });
    w.wake(m, at(6), 'activity', { trigger: 'merged', bucket: 'waiting_on_merge' });
    w.done(m, at(6, 1));
    const s = w.sheet(30);
    expect(s.today.lantern).toBe(true);
    expect(w.sheet(31).today.lantern).toBe(false);
    for (const id of ['lantern', 'lute', 'hourglass', 'tooth']) expect(loot(s, id).earned).toBe(true);
  });
});

describe('achievements', () => {
  it('earns First Blood, Hello World, Polyglot, Long Conversation and Patience of the Monk', () => {
    const w = world();
    const gh = w.item('gh', { seenDay: 0 });
    w.snooze(gh, at(0, 1), at(9), { untilActivity: true });
    w.wake(gh, at(1), 'activity', { trigger: 'comment' });
    w.ev(gh, at(1, 1), 'reply', null, null, 'sync');
    for (let i = 0; i < 5; i++) w.ev(gh, at(2, i), 'reply', null, null, 'sync');
    w.replied(w.item('yt', { provider: 'youtube', seenDay: 0 }), at(1, 2));
    const s = w.sheet(3);
    for (const id of ['first_blood', 'hello_world', 'polyglot', 'long_conversation', 'monk'])
      expect(ach(s, id).earned, id).toBe(true);
    expect(ach(s, 'hello_world').earnedOn).toBe('2026-11-03');
  });

  it('keeps hidden achievements nameless until earned', () => {
    const w = world();
    const s = w.sheet();
    expect(ach(s, 'rest')).toMatchObject({ hidden: true, name: null, description: null, progress: null });
    expect(ach(s, 'zero_hero')).toMatchObject({ name: 'Zero Hero', progress: { n: 0, of: 7 } });
  });

  it('counts todos, undos and a whole weekend off', () => {
    const w = world();
    for (let i = 0; i < 50; i++) w.done(w.item(`t${i}`, { provider: 'todo', seenDay: 0 }), at(0, 1 + i / 100));
    for (let i = 0; i < 10; i++) {
      const a = w.done(w.item(`u${i}`, { seenDay: 0 }), at(1, i / 10));
      w.undo(`u${i}`, at(1, i / 10 + 0.01), a);
    }
    // Days 5 and 6 are Saturday and Sunday 7-8 November: nothing happens then; day 7 has an action.
    w.done(w.item('mon', { seenDay: 0 }), at(7));
    const s = w.sheet(8);
    expect(ach(s, 'rubber_duck').earned).toBe(true);
    expect(ach(s, 'ctrl_z_adept').earned).toBe(true);
    expect(ach(s, 'rest')).toMatchObject({ earned: true, earnedOn: '2026-11-08', name: 'Rest Is a Skill' });
    expect(weekday(dayCounter('UTC').day(Date.parse(at(5))))).toBe(6);
  });
});

describe('days and time zones', () => {
  it('counts calendar days in the given zone, across DST changes', () => {
    const lon = dayCounter('Europe/London');
    // 23:30 UTC is still 28 March in London (GMT) but 30 March after the clocks go forward on the 29th.
    expect(lon.key(lon.day(Date.parse('2026-03-28T23:30:00Z')))).toBe('2026-03-28');
    expect(lon.key(lon.day(Date.parse('2026-03-29T23:30:00Z')))).toBe('2026-03-30');
    const ny = dayCounter('America/New_York');
    // The day the clocks go back has 25 hours; both of its ends land on 1 November.
    expect(ny.key(ny.day(Date.parse('2026-11-01T04:30:00Z')))).toBe('2026-11-01');
    expect(ny.key(ny.day(Date.parse('2026-11-02T04:30:00Z')))).toBe('2026-11-01');
    expect(ny.day(Date.parse('2026-11-02T05:30:00Z')) - ny.day(Date.parse('2026-10-31T12:00:00Z'))).toBe(2);
  });

  it('puts the day in the browser zone: a reply late on Sunday in LA is Sunday there, Monday in UTC', () => {
    const w = world();
    w.replied(w.item('a', { provider: 'youtube', seenDay: -3 }), '2026-11-02T05:00:00.000Z');
    expect(ach(w.sheet(3, 'UTC'), 'hello_world').earnedOn).toBe('2026-11-02');
    expect(ach(w.sheet(3, 'America/Los_Angeles'), 'hello_world').earnedOn).toBe('2026-11-01');
  });

  it('rejects an unknown zone', () => {
    const w = world();
    expect(() => w.sheet(3, 'Mars/Olympus_Mons')).toThrow(RangeError);
  });
});

describe('campfire rules', () => {
  // Days 0..n with explicit good/work sets.
  const fire = (good: number[], work: number[], today: number, decidedThrough = today - 1) =>
    campfire({
      good: (d) => good.includes(d),
      work: (d) => work.includes(d) || good.includes(d),
      days: [...good, ...work],
      today,
      decidedThrough,
    });
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  it('counts good days, and days with nothing to do neither break nor advance it', () => {
    expect(fire([0, 1, 2], [], 3)).toMatchObject({ current: 3, longest: 3, restUsed: false, notice: null });
    // Days 3-6 had nothing to do: the run carries on at day 7.
    expect(fire([0, 1, 2, 7], [], 7)).toMatchObject({ current: 4, notice: null });
  });

  it('covers the first miss with a rest day, and goes out on a second miss in the same run', () => {
    expect(fire([0, 1, 3], [2], 4)).toMatchObject({
      current: 3,
      restUsed: true,
      goodToRestore: CAMPFIRE.restoreAfterGood - 1,
      notice: { kind: 'forgiven', day: 2 },
    });
    expect(fire([0, 1, 3], [2, 4], 5)).toMatchObject({ current: 0, longest: 3, notice: { kind: 'out', day: 4 } });
    // Lit again by any good day: the notice goes.
    expect(fire([0, 1, 3, 6], [2, 4], 6)).toMatchObject({ current: 1, longest: 3, notice: null });
  });

  it('earns the rest day back after five good days', () => {
    const good = [0, ...range(2, 6)];
    expect(fire(good, [1], 6)).toMatchObject({ restUsed: false, notice: null, current: 6 });
    // So a second miss later is forgiven too.
    expect(fire([...good, 8], [1, 7], 8)).toMatchObject({ current: 7, notice: { kind: 'forgiven', day: 7 } });
  });

  it('does not judge a day until it is decided, and needs a run to miss anything', () => {
    expect(fire([0], [1], 1, 0)).toMatchObject({ current: 1, notice: null }); // today is never missed
    expect(fire([], [0, 1, 2], 3)).toMatchObject({ current: 0, notice: null });
  });

  describe('from the history', () => {
    // Inbox never empty: one item stays waiting throughout.
    const withWork = () => {
      const w = world();
      w.item('waiting', { seenDay: -1 });
      return w;
    };

    it('counts work done at 02:00 for the day before (04:00 rollover)', () => {
      const w = withWork();
      w.done(w.item('a', { seenDay: -1 }), at(0)); // Monday noon
      w.done(w.item('b', { seenDay: -1 }), '2026-11-04T02:00:00.000Z'); // 02:00 Wednesday = Tuesday
      const s = w.sheet(0, 'UTC', { now: '2026-11-05T11:00:00.000Z' }); // Thursday 11:00, Wednesday decided
      // Monday and Tuesday good, Wednesday missed (work, nothing done) and covered by the rest day.
      expect(s.campfire).toMatchObject({ current: 2, restUsed: true, notice: { kind: 'forgiven', day: '2026-11-04' } });
    });

    it('waits six hours past the rollover before calling a day missed', () => {
      const w = withWork();
      w.done(w.item('a', { seenDay: -1 }), at(0));
      // Tuesday ends at 04:00 Wednesday; not missed until 10:00 Wednesday.
      expect(w.sheet(0, 'UTC', { now: '2026-11-04T09:59:00.000Z' }).campfire.notice).toBeNull();
      expect(w.sheet(0, 'UTC', { now: '2026-11-04T10:01:00.000Z' }).campfire.notice).toEqual({
        kind: 'forgiven',
        day: '2026-11-03',
      });
    });

    it('never misses a day when there was nothing to do', () => {
      const w = world();
      w.done(w.item('a', { seenDay: -1 }), at(0)); // inbox now empty
      const s = w.sheet(10);
      expect(s.campfire).toMatchObject({ current: 1, restUsed: false, notice: null });
    });

    it('is lenient across a change of zone: good in either zone counts', () => {
      const w = withWork();
      w.done(w.item('a', { seenDay: -1 }), at(0)); // Monday
      // 06:00 UTC Wednesday: Wednesday in UTC, but 22:00 Tuesday in Los Angeles.
      w.done(w.item('b', { seenDay: -1 }), '2026-11-04T06:00:00.000Z');
      const now = '2026-11-05T20:00:00.000Z';
      // In UTC alone, Tuesday is a miss (forgiven).
      expect(w.sheet(0, 'UTC', { now }).campfire.notice).toEqual({ kind: 'forgiven', day: '2026-11-03' });
      // Having just come from Los Angeles, Tuesday counts as good: nothing missed. (Wednesday, in UTC, is good too.)
      expect(w.sheet(0, 'UTC', { now, prevTz: 'America/Los_Angeles' }).campfire).toMatchObject({
        notice: null,
        current: 3,
      });
    });

    it('keeps days whole across DST', () => {
      const w = world();
      w.item('waiting', { seenDay: -250 });
      // Good on Saturday 28 and Monday 30 March (London), Sunday 29 the clocks went forward and nothing was done.
      w.done(w.item('a', { seenDay: -250 }), '2026-03-28T12:00:00.000Z');
      w.done(w.item('b', { seenDay: -250 }), '2026-03-30T12:00:00.000Z');
      const s = w.sheet(0, 'Europe/London', { now: '2026-03-31T12:00:00.000Z' });
      expect(s.campfire).toMatchObject({ current: 2, notice: { kind: 'forgiven', day: '2026-03-29' } });
      expect(campDays('Europe/London')(Date.parse('2026-03-30T02:30:00Z'))).toBe(
        dayCounter('UTC').day(Date.parse('2026-03-29T12:00:00Z')),
      );
    });
  });
});

describe('claims (what to announce)', () => {
  const base = () => {
    const w = world();
    for (let i = 0; i < 12; i++) w.done(w.item(`i${i}`, { seenDay: 0 }), at(1, i / 10)); // 96 XP
    return w;
  };

  it('arrives without replaying the past, then announces a level-up once', () => {
    const w = base();
    const first = planClaim(w.sheet(1), null);
    expect(first.news).toMatchObject({ arrive: { level: 1, title: 'Inbox Peasant' }, levelUp: null, achievements: [] });
    expect(first.seen.achievements).toContain('first_blood');
    w.done(w.item('x', { seenDay: 0 }), at(1, 2));
    const second = planClaim(w.sheet(1), first.seen);
    expect(second.news).toMatchObject({ arrive: null, levelUp: { from: 1, to: 2, title: 'Apprentice of the Unread' } });
    expect(planClaim(w.sheet(1), second.seen).news.levelUp).toBeNull();
  });

  it('is silent when an undo takes a level away, and does not announce it again when it comes back', () => {
    const w = base();
    const a = w.done(w.item('x', { seenDay: 0 }), at(1, 2));
    const s1 = planClaim(w.sheet(1), { level: 2, achievements: [], bosses: [], loot: [] }).seen;
    w.undo('x', at(1, 3), a);
    expect(w.sheet(1).level).toBe(1);
    const s2 = planClaim(w.sheet(1), s1);
    expect(s2.news.levelUp).toBeNull();
    w.done('x', at(1, 4));
    expect(planClaim(w.sheet(1), s2.seen).news.levelUp).toBeNull();
  });

  it('announces achievements, bosses and loud loot once each, and the lantern once a day', () => {
    const w = world();
    const s0 = planClaim(w.sheet(1), null).seen;
    w.done(w.item('old', { seenDay: 0, ageDays: 400 }), at(1));
    const c1 = planClaim(w.sheet(1), s0);
    expect(c1.news.achievements.map((a) => a.id)).toEqual(['first_blood', 'archaeologist']);
    expect(c1.news.bosses.map((b) => b.id)).toEqual(['elder_wyrm']);
    expect(c1.news.loot.map((l) => l.id)).toEqual(['lantern']);
    expect(planClaim(w.sheet(1), c1.seen).news).toMatchObject({ achievements: [], bosses: [], loot: [] });
    w.done(w.item('old2', { seenDay: 0, ageDays: 100 }), at(2));
    expect(planClaim(w.sheet(2), c1.seen).news.loot.map((l) => l.id)).toEqual(['lantern']);
  });

  it('mentions a missed campfire day once', () => {
    const w = world();
    w.item('waiting', { seenDay: -1 });
    w.done(w.item('a', { seenDay: -1 }), at(0));
    const s0 = planClaim(w.sheet(0), null).seen;
    const later = w.sheet(2);
    const c1 = planClaim(later, s0);
    expect(c1.news.campfire).toEqual({ kind: 'forgiven', day: '2026-11-03' });
    expect(planClaim(later, c1.seen).news.campfire).toBeNull();
  });
});

describe('read only', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('works on a database opened read-only (it never writes)', () => {
    dir = mkdtempSync(join(tmpdir(), 'nudge-rpg-'));
    const path = join(dir, 'x.db');
    const db: Db = openDb(path);
    db.prepare(
      `INSERT INTO items (id, provider, kind, occurred_at, state, state_source, state_changed_at, first_seen_at)
       VALUES ('a', 'github', 'pr', ?, 'inbox', 'sync', ?, ?)`,
    ).run(at(-5), at(-5), at(-5));
    db.prepare(
      `INSERT INTO item_events (item_id, at, kind, from_value, to_value, source, meta)
       VALUES ('a', ?, 'state', 'inbox', 'done', 'user', '{"actionId":1,"reason":"done"}')`,
    ).run(at(1));
    db.close();
    const ro = new Database(path, { readonly: true });
    try {
      const reader = createRpgReader(ro, () => new Date(at(2)));
      expect(reader.sheet('UTC', null).xp).toBeGreaterThan(0);
      expect(reader.sheet('Europe/London', null, 'UTC').level).toBe(1);
    } finally {
      ro.close();
    }
  });
});
