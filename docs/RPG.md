# Adventure mode: a cosmetic RPG layer for triage

Status: built (2026-11-16), on by default. Server: `server/db/rpg.ts` (reads only), `server/routes/rpg.ts`, with the
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
Elder Wyrm, Archaeologist, the Bard's Lute, Backlog Breaker) uses `occurred_at`, when the thing was written.

## 3. Levels

Total XP to reach level _n_ is `100 × (n−1)²`: level 2 needs 100, level 5 needs 1,600, level 10 needs 8,100 and level
20 needs 36,100. Past 20 the titles come round again "of the Second Age", "of the Third Age" and so on.

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

Achievements are earned once each. The Hall shows them all, with progress for the counting ones; the hidden ones
(Half-Life, Long Conversation, Rest Is a Skill, Ctrl+Z Adept) show as a greyed "???" badge until earned.

1. **First Blood**: your first resolution.
2. **Hello, World**: your first reply.
3. **Inbox Zero**: the first day the inbox reached zero.
4. **Zero Hero**: inbox at zero on 7 separate days (not necessarily consecutive).
5. **Archaeologist**: deal with something more than a year old.
6. **Welcome Wagon**: reply to 10 newcomers.
7. **Patience of the Monk**: an until-activity snooze woke on activity, and your next move was a reply.
8. **Auditor**: clear 10 "Still waiting" items by done or reply.
9. **Rubber Duck**: complete 50 todos.
10. **Backlog Breaker**: there was something 30 days old in the inbox, and later nothing that old was left.
11. **Ancient Evil Vanquished**: the same for a year.
12. **Half-Life**: the inbox count halves from an all-time peak of at least 10.
13. **Polyglot**: reply on YouTube and on GitHub on the same day.
14. **Long Conversation**: reply 5 times on the same thread.
15. **Rest Is a Skill**: a whole Saturday and Sunday with no actions at all.
16. **Ctrl+Z Adept**: 10 undos.

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
  `{ enabled, sound, title, seen: { level, achievements[], bosses[], loot[] } | null, tz, prevTz }`, so phone and
  desktop agree. `seen.loot` also holds `lantern:<day>` and `camp:<kind>:<day>` keys (the latest few of each).
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
