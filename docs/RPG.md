# Adventure mode: a cosmetic RPG layer for triage

Status: built (2026-11-16), on by default; rebalanced the same month (slower curve, achievement ladders: §3, §5). Server: `server/db/rpg.ts` (reads only), `server/routes/rpg.ts`, with the
inbox replay in `server/db/replay.ts` and the history helpers in `server/db/history.ts` (both shared with Insights). Shared
catalogue and level maths: `shared/rpg.ts`. Web: `web/src/lib/rpg.ts`, `web/src/lib/levelSound.ts`,
`web/src/lib/stores/rpg.svelte.ts`, and the `Rpg*` / `HallOfHeroes` components.

Nudge already records every decision in `item_events`. Adventure mode reads that history and turns it into a level,
a silly title, a few trophies and the odd line of flavour text. It is decoration on top of the app. It never changes
how the app works.

## 1. Principles

| Rule                                                                                                                                                   | How it is enforced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No functional difference.** Nothing unlocks, speeds up, hides, reorders, limits or changes items, suggestions, snoozes, keys, notifications or data. | `server/db/rpg.ts` only prepares SELECTs; a test runs it against a database opened read-only, and another checks its source holds no write statement. The routes write only the mode's own `settings` row. The repository has no ESLint, so the import restriction is a test, `server/rpg-boundary.test.ts`: only an allow-list of files (the RPG files themselves, `app.ts`, `index.ts`, `App.svelte`, `Sidebar.svelte`, `CommandPalette.svelte`, `StatsView.svelte`) may import anything of the RPG layer, so inbox, keys, snooze, suggestion, sync and push code cannot. `server/routes/rpg.test.ts` checks that `/api/inbox` (every view) and `/api/bootstrap` (counts included) give byte-identical output with the mode on and off, and after the sheet has been asked for. |
| **Nothing is shown when a decision is made.**                                                                                                          | No XP on rows, buttons, the item toolbar, the thread view or the snooze menu (the boundary test also checks those files never mention XP or the mode). XP appears only after the fact, in the chip and the Hall.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Care over speed.**                                                                                                                                   | No speed, combo, per-hour or per-day-count rewards. Nothing depends on how long an item was open or how fast you got through the list. Bulk actions pay a token rate and fell no bosses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Missing a day is mentioned, kindly, and costs nothing.**                                                                                             | The campfire (§5) notices a day with work waiting and nothing done, forgives one per run, and says so in one small line. No XP, level, loot or achievement is ever taken away for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Snoozing and dismissing don't pay.**                                                                                                                 | Snoozing earns 0. "No action needed" earns a token 1 XP. Bulk actions pay the token rate. Each item pays once (§2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Off means off.**                                                                                                                                     | One Settings toggle hides the chip, toasts, the logo hat and the Hall, removes the palette entry, silences the chime, and the web app stops calling `/api/rpg` (an e2e test watches the network).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Achievements we deliberately do **not** build: Night Owl, Speed Demon, 100 In A Day, 365-day streak, and anything
that counts snoozes or dismissals.

## 2. XP model

XP is a **pure function of `item_events` + `items`** (`provider`, `kind`, `first_seen_at`, `occurred_at`, and from
`data` the GitHub `association` and `comments`). Because it is computed from history it applies to everything already
done, and it needs no new write path. The only storage is the `rpg` row in `settings` (§6), which needs no migration.

**Per-item payout, at most once.** For each item, take the owner's resolution events that were _not undone_. An undo
cancels its original event, matched by `meta.originalEventId`, and also every user event of the same item carrying
the same `meta.actionId` (which covers rows backfilled before `item_events` existed, and the extra `reply` event an
app-posted reply writes). The item pays for the **best** of what is left, once. So:

- an undo removes the XP, with no extra code;
- done → reopened upstream → done again pays once;
- a Done item that comes back on new GitHub activity **keeps** its XP. Nothing is ever taken away for something
  someone else did;
- an item deleted since (a purged source) keeps what it paid.

| Event (from `item_events`)                                                                                                       | Base XP        |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `reply`, source `user` (YouTube, posted from Nudge), or `state` → `replied` by the user (the copy-and-open hand-off)             | 10             |
| `reply`, source `sync` (a reply you made on github.com; sync only records one when the newest commenter is one of your accounts) | 10             |
| `state` → `done`, `meta.reason = 'done'`, GitHub or YouTube item                                                                 | 8              |
| `state` → `done`, todo                                                                                                           | 5              |
| `state` → `done` with no reason (legacy, before dismissals existed)                                                              | 4              |
| `state` → `done`, `meta.reason = 'no_action'` (dismissal)                                                                        | 1              |
| Any resolution carrying a `meta.actionId` that resolved more than one item (bulk)                                                | 1 (no bonuses) |
| `snooze`, `unsnooze`, `mute` (archive), `open`, `decision`                                                                       | 0              |
| Source `auto` or `sync` state changes (closed or merged upstream, auto-replied)                                                  | 0              |

**Bonuses.** Replies and dones only: never dismissals, legacy dones (they may have been dismissals) or bulk actions.

- **Patience**: +1 per full week between `first_seen_at` and the resolution, capped at +20.
- **Audit cleared**: +5 when the item came back from a `fallback` wake ("Still waiting") and the owner's next move on
  it was done or reply. A re-snooze earns nothing.
- **Welcome**: +5 for a reply on a GitHub item whose author is a newcomer: `items.data.association` is
  `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE` or `MANNEQUIN` (the "First time" and "Outside" chips). The poller
  rewrites `data` on every poll, so this is the author's current relation.

XP is never spent and never decays. Undo is the only thing that lowers it, and a level lost to an undo is silent (and
not announced again when it comes back).

**Ages.** Patience measures time in Nudge (`first_seen_at`). Everything else that asks "how old" (the lantern, the
Elder Wyrm, Archaeologist, Necromancer, the Bard's Lute, Backlog Breaker) uses `occurred_at`, when the thing was written.

## 3. Levels

Total XP to reach level _n_ is `300 × (n−1)^1.6`, rounded to the nearest 10 (`LEVEL_CURVE` in `shared/rpg.ts`). The
first curve (`100 × (n−1)²`) put the owner at level 5 of 20 after his first ten days (1,627 XP, inflated by a one-off
backlog cleanup), so the game felt half over. On this one those 1,627 XP are level 3. At a steady few dozen XP a day,
level 10 comes after a few months and level 20 after well over a year. Past 20 the titles come round again "of the
Second Age", "of the Third Age" and so on, and the curve carries on.

| Lv  | Total XP | Lv  | Total XP | Lv  | Total XP |
| --- | -------- | --- | -------- | --- | -------- |
| 1   | 0        | 11  | 11,940   | 21  | 36,210   |
| 2   | 300      | 12  | 13,910   | 22  | 39,140   |
| 3   | 910      | 13  | 15,990   | 23  | 42,170   |
| 4   | 1,740    | 14  | 18,170   | 24  | 45,280   |
| 5   | 2,760    | 15  | 20,460   | 25  | 48,470   |
| 6   | 3,940    | 16  | 22,850   | 26  | 51,740   |
| 7   | 5,270    | 17  | 25,330   | 27  | 55,090   |
| 8   | 6,750    | 18  | 27,920   | 28  | 58,520   |
| 9   | 8,360    | 19  | 30,590   | 29  | 62,030   |
| 10  | 10,090   | 20  | 33,350   | 30  | 65,610   |

| Lv  | Title                         | Lv  | Title                                       |
| --- | ----------------------------- | --- | ------------------------------------------- |
| 1   | Inbox Peasant                 | 11  | Warlock of the Cron Table                   |
| 2   | Apprentice of the Unread      | 12  | Bard of the Reply Box                       |
| 3   | Squire of Snooze              | 13  | Sorcerer of the Assembly Pane               |
| 4   | Keeper of the Queue           | 14  | Lich-Slayer of Stale Issues                 |
| 5   | Hedge Wizard of Triage        | 15  | Druid of the Dependency Tree                |
| 6   | Journeyman Janitor of Threads | 16  | Grand Inquisitor of Flaky Tests             |
| 7   | Ranger of the Backlog         | 17  | Dragon-Tamer of the Monorepo                |
| 8   | Knight of the Round-Robin     | 18  | High Priest of /dev/null                    |
| 9   | Cleric of the Clean Shutdown  | 19  | Elder of the Elder Issues                   |
| 10  | Paladin of the Pull Request   | 20  | Benevolent Dictator of the Inbox (For Life) |

The character drawing changes with the level: peasant (1-2), apprentice (3-5), wizard (6-9), paladin (10-14),
dragon-tamer (15-19), crowned dictator (20+).

**Toasts.** Whatever a claim (§6) hands out goes into **one** ordinary toast from the existing `Toasts` stack
(`aria-live="polite"`, no focus change, no key, closes itself after 8 seconds): for example _"Ding! Level 7: Ranger of
the Backlog. +1 Wisdom (does nothing)."_ Several levels at once read "Levels 5 to 7". Bosses, achievements, loot
lines and a missed campfire day join the same toast; past three parts it ends "And N more in the Hall of Heroes". The
first claim after the mode is switched on says only _"You arrive as a Level 9 Cleric of the Clean Shutdown."_, and
nothing earned earlier is replayed. Claims are only made while the tab is visible.

**The chime.** A level-up toast (and only that: never the arrival, never anything else) plays a short bell-like
rising arpeggio, about a second long, synthesised with the Web Audio API (sine partials with a slightly inharmonic
overtone and a soft triangle an octave down, fast attack, exponential ring-out). No recorded or copied audio. It plays
only when the tab is visible and the "Level-up sound" setting is on. Browsers allow audio only after a gesture, so the
audio context is made or resumed on the first key or click while the chime is wanted; if that is blocked or
unsupported it silently does nothing. It never plays on page load. There are no other sounds, and no vibration or push
notification, ever. The chip's avatar gives one small sparkle on a level-up, which `prefers-reduced-motion` turns off;
nothing else moves.

## 4. Power-ups and loot (all cosmetic)

Each one changes a small piece of decoration in the chip, the Hall or the brand logo. None appears in the item list.

| Loot                        | Earned by                                                                                                  | Effect                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Cloak of Inbox Zero         | Inbox reaches zero today                                                                                   | Cloak glyph on the chip for the rest of the day                                                                          |
| Necromancer's Lantern       | Done or reply (not bulk) on an item ≥ 90 days old                                                          | Lantern on the chip today. Toast once a day: _"The dead issue rests."_                                                   |
| Wizard Hat                  | Levelling up                                                                                               | Tiny hat on the Nudge logo for the rest of the day                                                                       |
| Quill of Welcome            | A reply to a newcomer                                                                                      | Quill in the Hall                                                                                                        |
| Ring of Ctrl+Z              | First undo                                                                                                 | Ring in the Hall. Toast: _"Time is a flat circle."_                                                                      |
| Phosphor Accent             | Level 10                                                                                                   | XP bar in green-screen phosphor                                                                                          |
| Amber Accent                | Level 15                                                                                                   | XP bar in amber terminal (wins over phosphor)                                                                            |
| Chosen Title                | Any title reached                                                                                          | The Hall's picker chooses which earned title the chip shows                                                              |
| Procrastinator's Redemption | Done on an item snoozed ≥ 3 times                                                                          | Hourglass in the Hall                                                                                                    |
| Mimic's Tooth               | A `waiting_on_merge` snooze wakes because it merged (`meta.trigger = 'merged'`), and you then mark it done | Tooth in the Hall. Toast: _"It was a PR all along."_                                                                     |
| Bard's Lute                 | Reply to a YouTube comment ≥ 30 days old                                                                   | Lute in the Hall. Toast: _"A long-awaited ballad."_                                                                      |
| Loot log                    | Every 20th paying item, the find chosen by a hash of the item id, never by chance                          | A worthless item in the Hall: _"a semicolon (lowercase)"_, _"one unused #include"_, _"a deprecated cursor"_... No toast. |

**Bosses.** Each gets a portrait in the Hall (a grey silhouette until it falls), a count of times fallen, and a toast
line the first time. Only a done or reply counts: never a dismissal or a bulk action.

| Boss            | Who                                                                                    | Line                                                         |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The Ancient One | The oldest item in an inbox of at least five, at the moment you dealt with it          | _"The Ancient One falls. The backlog trembles."_             |
| The Hydra       | A GitHub thread with ≥ 20 comments (`items.data.comments`, the count at the last poll) | _"Cut off one head, two more comments grow. Not this time."_ |
| The Lich        | An item that came back from a fallback wake twice, then was resolved                   | _"Its phylactery was a stale branch."_                       |
| The Elder Wyrm  | Anything more than a year old                                                          | _"It had hoarded 400 days of guilt."_                        |

## 5. Achievements and the campfire

Forty achievements, most of them **ladders**: one card each, with tiers earned at rising counts (Rubber Duck I at 10
todos, II at 50, III at 200 and so on), 129 tiers in all. The card shows the highest tier earned as a numeral, what the
next tier takes, a thin progress bar and "II of V · earned Monday". The badge is the same drawing at every tier,
upgraded: the ring goes bronze, silver, gold, platinum, mithril, adamant, a plaque on the ribbon carries the numeral,
and from tier IV a star-burst sits behind the medal. An unearned ladder is a grey silhouette marked "I". Counts never go
down, so a tier once earned stays earned. One-offs keep the plain gold ring and no numeral. Hidden ones show as a greyed
"???" until their first tier. A claim announces only the highest new tier of each ladder ("Achievement: Rubber Duck
II.").

| Achievement                   | Counts                                                                   | Tiers                                  |
| ----------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| First Blood                   | your first resolution                                                    | once                                   |
| Hello, World                  | your first reply                                                         | once                                   |
| Inbox Zero                    | the first day the inbox reached zero                                     | once                                   |
| Veteran of the Queue          | items dealt with (done or reply; never a dismissal or a bulk action)     | 100, 500, 1,500, 4,000, 10,000, 25,000 |
| Town Crier                    | replies                                                                  | 25, 100, 300, 1,000, 3,000             |
| Rubber Duck                   | todos completed                                                          | 10, 50, 200, 500, 1,000                |
| Zero Hero                     | days the inbox was at zero (not necessarily consecutive)                 | 7, 30, 100, 250, 500                   |
| Steady Hand                   | good campfire days in all, in a row or not                               | 10, 50, 150, 365, 730                  |
| Keeper of the Flame           | the longest campfire run (rest days and all)                             | 7, 30, 100                             |
| Ascendant                     | the highest level reached                                                | 5, 10, 15, 20, 30, 40                  |
| Fan Mail                      | YouTube comments replied to                                              | 10, 50, 200, 500                       |
| Reviewer of Pulls             | GitHub pull requests dealt with                                          | 10, 50, 200, 500, 1,000                |
| Bug Wrangler                  | GitHub issues dealt with                                                 | 10, 50, 200, 500, 1,000                |
| Welcome Wagon                 | newcomers replied to                                                     | 5, 25, 100, 250, 500                   |
| Polyglot                      | days with a reply on YouTube and one on GitHub                           | 1, 10, 50, 150, 365                    |
| Patience of the Monk          | an until-activity snooze woke on activity and your next move was a reply | 1, 10, 50, 150                         |
| Auditor                       | "Still waiting" items cleared by done or reply                           | 10, 50, 150, 400, 1,000                |
| Second Wind                   | things finished after being snoozed three times or more                  | 1, 10, 50, 150                         |
| Mimic Hunter                  | merge waits that merged and were then marked done                        | 1, 5, 25                               |
| Minstrel                      | YouTube comments 30 days old or more answered                            | 1, 10, 50                              |
| Necromancer                   | things 90 days old or more dealt with                                    | 5, 25, 100, 300                        |
| Archaeologist                 | things more than a year old dealt with (the Elder Wyrm's ladder)         | 1, 10, 50, 150, 500                    |
| Backlog Breaker               | there was something 30 days old in the inbox, and later nothing that old | once                                   |
| Ancient Evil Vanquished       | the same for a year                                                      | once                                   |
| Bane of the Ancient One       | times the Ancient One fell                                               | 1, 10, 50, 150                         |
| Hydra Hunter                  | times the Hydra fell                                                     | 1, 5, 20, 60                           |
| Lich-Bane                     | times the Lich fell                                                      | 1, 5, 20, 60                           |
| Trophy Case                   | tiers earned on every other achievement                                  | 10, 25, 50, 80, 110                    |
| Half-Life (hidden)            | the inbox halves from an all-time peak of at least 10                    | once                                   |
| Long Conversation (hidden)    | replies on one thread                                                    | 5, 10, 20, 40                          |
| Rest Is a Skill (hidden)      | whole weekends with no actions at all                                    | 1, 5, 20                               |
| Ctrl+Z Adept (hidden)         | undos                                                                    | 10, 50, 200, 500                       |
| The Answer (hidden)           | your 42nd reply                                                          | once                                   |
| L33t (hidden)                 | 1,337 XP                                                                 | once                                   |
| Off-by-One (hidden)           | undo something, then do it after all                                     | once                                   |
| Groundhog Day (hidden)        | mark the same item done three times (it kept coming back)                | once                                   |
| Forbidden Necromancy (hidden) | deal with something over three years old                                 | once                                   |
| Spooky Season (hidden)        | deal with something on 31 October                                        | once                                   |
| Leap of Faith (hidden)        | deal with something on 29 February                                       | once                                   |
| Quack (hidden)                | complete a todo with "duck" in its title                                 | once                                   |

None of these counts snoozes, dismissals, speed or how much was done in one day, and Keeper of the Flame stops at 100
good days: the year-long streak stays on the "never build" list (§1). The silly thresholds are `SILLY` in
`server/db/rpg.ts`. The level-based loot (phosphor at 10, amber at 15) and the avatar tiers kept their levels: on the
slower curve they are months away rather than days.

### Rebalancing

The thresholds can change, and since everything is worked out from history the new rules apply to the past at once.
What has been announced is stored in `seen`, which then no longer lines up: the stored level may be above the new one,
and an old one-off may now be tier I or II of a ladder. `seen.v` records the rules version (`RPG_SEEN_VERSION` in
`shared/rpg.ts`; a row without it is version 1). The first claim on a newer version says only _"The dungeon grew.
Levels were re-forged. You stand at Level 3: Squire of Snooze."_ (no chime), marks everything earned so far as seen, and
sets the stored level to the new one. So nothing is replayed, a lowered level brings no toast, and the next level-up or
tier is announced as usual. A tier earned between the last claim and the rebalance gets no toast of its own: it is in
the Hall. Bump the version whenever a change to the curve or the catalogue would otherwise replay or skip announcements.

**Inbox zero by replay.** Whether the inbox hit zero, and when there was work waiting, is worked out by replaying
arrivals (`first_seen_at`, in the state the first state event's `from` says, else the current one), state, snooze and
undo events, and the moments snoozes ran out, in time order, keeping a running count of the inbox as the Inbox view
defines it (state `inbox`, not snoozed). A test checks the replay against the real repository after triage, bulk
actions, undo, snoozes and the waker. History from before `item_events` existed (migration 9) is approximate.

**The campfire.** Days here are campfire days: local days in the browser's zone that roll over at **04:00**, so
late-night triage counts for the day before.

- A **good day** has a reply, a done (not a dismissal, not bulk), or the inbox reaching zero while there was work.
- A **missed day** had work (something in the inbox, not snoozed away, at some point) and no good action.
- A day with **nothing to do** is neither: it never breaks or advances anything.
- A day is only judged missed once it is over by **six hours** past the rollover (10:00 the next day), so a late
  night or a change of zone never produces a false miss.
- A run is lit by any good day and counts its good days. The **first miss in a run is forgiven** (a "rest day", shown
  as used in the Hall). A **second miss while the rest day is spent puts the fire out**. The rest day comes back after
  **five good days**, so one miss never leaves you permanently on the edge.
- **Time zones.** Only the current browser zone is known. The `rpg` row remembers the zone of the last claim and,
  when it changes, the one before; a day then counts as good if it was good in either zone, so travelling cannot turn
  a day of work into a miss. Work and inbox zero are judged in the current zone.
- **Words.** The chip shows a flame from three good days. When a day was missed, one small line appears in the chip's
  tooltip and the Hall: _"You missed Tuesday. The campfire flickers. A rest day covered it."_ or _"The campfire went
  out on Tuesday. Light it again with any reply."_, plus, the first time it is noticed, that line in one self-closing
  toast (remembered in `seen`, so it never repeats). The Hall keeps the longest run. Nothing else changes: no XP,
  level, loot or achievement is ever lost.

Calendar-day things (the cloak, the lantern, the hat, achievement dates) use plain local midnight in the browser's
zone, passed as `?tz=` (`{tz}` for the claim). The rules are constants in `server/db/rpg.ts` (`CAMPFIRE`).

## 6. Where it shows

- **Sidebar chip.** In the footer group above `SyncIndicator`: the character, _"Lv 7 · Ranger of the Backlog"_ (or the
  chosen title), a 2px XP bar, and today's glyphs (cloak, lantern, flame). Its tooltip gives XP to the next level, the
  campfire and any missed-day line. It is a link to the Hall and takes no keybinding; the command palette has
  "Character sheet". The brand logo wears the wizard hat on a level-up day.
- **The Hall of Heroes.** A section at the bottom of Stats: the character, level and XP bar, tallies, the campfire,
  the title picker, trophies (bosses), achievements (greyed silhouettes until earned, "???" for the hidden ones), loot
  and the loot log.
- **Phone.** The chip sits in the footer the "More" button reveals, so it adds nothing to the main phone screen. The
  Hall stacks into one column. Toasts behave as on desktop.
- **Settings → Appearance.** "Adventure mode (levels, titles, silly loot)" and "Level-up sound", both on by default.
  They live server-side in the `settings` table under `rpg`, as
  `{ enabled, sound, title, seen: { v, level, achievements[], bosses[], loot[] } | null, tz, prevTz }`, so phone and
  desktop agree. `seen.achievements` holds the bare id for tier I and `id:k` for tier k. `seen.loot` also holds `lantern:<day>` and `camp:<kind>:<day>` keys (the latest few of each).
  Switching the mode back on clears `seen`, which gives a fresh "You arrive as..." and no replay.
- **API.** `GET /api/rpg?tz=` returns the sheet (409 `rpg_off` when off, 400 for an unknown zone). `POST
/api/rpg/claim {tz}` returns the sheet and what is new since the last claim from any device, and records it as
  seen, synchronously, so two devices cannot both announce the same thing. The sheet is cached until the history
  changes or a minute passes.
- **Demo.** `POST /api/demo/rpg-clock {hours}` (demo servers only) runs the mode's own clock ahead, so e2e can show a
  missed campfire day; 0 puts it back.

## 7. Decisions

1. Dismissals pay 1 XP.
2. A Done item that comes back on new activity keeps its XP.
3. On by default, for the real install and for demo mode.
4. State is a server-side `settings` row, so a level-up is announced once rather than once per device.
5. The level appears only in the sidebar chip and the Hall.
6. The data the doc assumed is there: `items.data.association` and `items.data.comments` are written by the GitHub
   poller on every poll, so the welcome bonus and the Hydra use them as planned.
