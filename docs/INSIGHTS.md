# Insights: what your inbox says about you

Status: proposal (2026-11-16). Nothing here is built.

A read-only section at the top of Stats that answers "when does stuff arrive, what do I do with it, and how good is the
suggestion model?" Every number comes from tables that already exist. Sibling of [RPG.md](RPG.md): same history-first
approach, same `?tz=` handling and cache key, no XP and no achievements here.

## 1. Principles

| Rule                                   | How it is enforced                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read-only, no effect on the inbox.** | `server/db/insights.ts` only reads; a test runs it against a database opened read-only. Inbox, keys, snooze, suggestion and push code may not import it (ESLint `no-restricted-imports`, same rule as `rpg`).                                                                            |
| **Honest numbers.**                    | Every figure carries its _n_ ("62% of 41 items"). Below a card's minimum sample it shows _"Not enough data yet (n of N)"_ instead of a number. Rates use whole items, not events. Captions describe ("you reply more to short threads"), never explain ("short threads make you reply"). |
| **No guilt.**                          | No "you are slow", no red for old items, no targets, no streaks. Backlog age is a shape, not a score. Quiet days are a feature (_"Wednesday: blissfully quiet"_).                                                                                                                        |
| **Works on nothing.**                  | Empty DB, a demo DB and a week-old DB all render: each card has its own empty state, the page never errors.                                                                                                                                                                              |
| **Phone friendly.**                    | One column under 640px, no hover-only information (every chart has a tap-to-show table), no horizontal scroll.                                                                                                                                                                           |
| **Stays local, no LLM.**               | Plain SQL + JS. Commenter names appear only as aggregates the app already shows (item authors). Bots (`data.authorType = 'Bot'`) and his own items (`is_own = 1`) are excluded from "people" rankings.                                                                                   |

## 2. What the data can and can't say

- **His actions**: `item_events` with `source = 'user'`, kinds `state`/`snooze`/`reply`, minus anything cancelled by an
  `undo` (match by `meta.originalEventId`, else `meta.actionId` + kind, as RPG §2). Bulk actions (`meta.actionId`
  shared by >1 item, or a `decision` row with `bulk`) are counted for rhythm but **excluded** from per-item rates, exactly as
  `habits.ts` does.
- **Outcome of an item** = its first non-undone user resolution: _replied_ (`state → replied`, or a `reply` event,
  including GitHub `reply/sync` with his login), _done_ (`meta.reason = 'done'`), _dismissed_ (`meta.reason =
'no_action'`), _done (legacy)_ (no reason; shown as its own grey segment, never folded into done or dismissed),
  _snoozed first_, _upstream_ (`sync`/`auto` closed it before he did), _still waiting_.
- **Arrivals**: no arrival event exists (deliberately: imports would write thousands). Use `items.first_seen_at` for
  items that arrived _live_: `is_own = 0`, `muted = 0`, and `first_seen_at − occurred_at < 48h` (filters imports and
  backfills). Re-arrivals are `state` events `source = 'sync'`, `to_value = 'inbox'` (`meta.reason` `new_activity` /
  `reopened`). For "what time do people write", use `occurred_at` (YouTube publish time, GitHub createdAt) on the
  same live set.
- **Containers**: YouTube `items.container_key` = video id, `container_title` = video title, channel via
  `videos.channel_title`; GitHub `container_key` = `owner/repo`; todos have none.
- **Thread size**: YouTube `threads.total_reply_count` (via `comments.thread_id`); GitHub `items.data.comments`. Both
  are _current_ size, not size when he acted. GitHub snooze events carry `meta.comments` at the time; nothing else does.
- **Predictions**: every user action since migration 011 carries `meta.suggested` (reply/act/skip/spam),
  `meta.suggestedConfidence` and, since 012, `meta.suggestedTurn`. The category and the prompt version are **not** on
  the event; `suggestions` keeps only the current row per item.

**New capture needed (two meta keys, no migration, no new table):**

- **C1** `suggestedCategory` and `suggestedPrompt` (`prompt_version`) alongside `suggested` in `events.ts`
  `suggestionMeta()`. One SELECT gains two columns. Before C1, category is approximated by joining today's
  `suggestions.category` and labelled _"approx."_.
- **C2** `threadSize` on user `state`/`reply` events: comment count at the moment he acted (`data.comments` or
  `threads.total_reply_count`, already in hand in `triage()`). Before C2, cards use current size and say so.

## 3. The catalogue

Status: **now** = derivable today; **C1/C2** = needs that capture (shows an approximation or a "collecting since…"
note until enough rows exist). Min = below this the card shows "Not enough data yet".

### Rhythm

| #   | Card (label · caption)                                                                              | Question                                | Source                                                               | Figure                                                                            | Min                       | Status |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------- | ------ |
| R1  | **When the world writes** · _"Peak arrivals: Tuesdays 4pm. The internet has opinions after lunch."_ | When does stuff arrive?                 | live items by `first_seen_at` (local) + re-arrival events            | 7×24 heatmap, one sequential hue, cell = count ÷ number of such weekdays in range | 50 arrivals               | now    |
| R2  | **When you triage** · _"Mostly 8–10am. The coffee window."_                                         | When does he act?                       | user `state`/`snooze`/`reply` events (bulk counted once per action)  | 7×24 heatmap, same scale rule, next to R1                                         | 50 actions                | now    |
| R3  | **Hour by hour**                                                                                    | Arrivals vs actions across the day      | R1 + R2 collapsed to 24 bins                                         | Two small 24-column bar charts stacked (one axis each, never dual-axis)           | 50 each                   | now    |
| R4  | **First response time** · _"Median 6h for GitHub, 2d for YouTube."_                                 | How long till he first touches an item? | first user action − `first_seen_at`, by provider and by arrival hour | Meter list per provider (median + p75 text); 24-bin bars for by-hour              | 10 per provider / per bin | now    |

### Sources

| #   | Card                                                                               | Question                               | Source                                                            | Figure                                                | Min                   | Status             |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- | --------------------- | ------------------ |
| S1  | **Noisiest repos**                                                                 | Which repos send the most?             | live items + re-arrivals, `provider='github'`, by `container_key` | Ranked horizontal bars, top 8 + "Other"               | 5 items total         | now                |
| S2  | **Chattiest videos** · _"'Advent of Compiler Optimisations #12' just won't stop."_ | Which videos draw comments?            | YouTube items by `container_key` → `container_title`              | Ranked bars, top 8                                    | 5                     | now                |
| S3  | **Channels**                                                                       | Which tracked channel brings the work? | items → `videos.channel_title`                                    | Ranked bars                                           | 2 channels with ≥5    | now                |
| S4  | **Regulars** · _"Your most loyal correspondent."_                                  | Who writes most?                       | `items.author`, excluding own/bots, distinct items                | Ranked bars, top 5, names only (no avatars, no links) | author with ≥3 items  | now                |
| S5  | **Longest threads**                                                                | Biggest conversations in range         | `threads.total_reply_count`, GitHub `data.comments`               | Top-5 list, links open the item in Nudge              | 1 thread ≥10 comments | now (current size) |
| S6  | **What it's made of**                                                              | Mix by provider/kind                   | items by `provider`,`kind`                                        | Tall segmented bar (≤6 parts)                         | 10                    | now                |

### Responses

| #   | Card                                                                              | Question                                         | Source                                                                            | Figure                                                                                   | Min            | Status                            |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------- | --------------------------------- |
| P1  | **What happens to things** · _"41% replied, 30% done, 18% waved through."_        | Outcome split                                    | outcome per item (§2), single actions only                                        | Tall segmented bar: replied / done / dismissed / snoozed first (+ grey legacy, upstream) | 20 resolved    | now                               |
| P2  | **Reply rate by source**                                                          | Does he reply more to PRs, issues or comments?   | P1 by `provider`+`kind`                                                           | Meter list, n beside each row                                                            | 10 per row     | now                               |
| P3  | **Reply rate by thread size** · _"Short threads get answers; epics get snoozed."_ | Does size change what he does?                   | P1 by size band 0 / 1–3 / 4–10 / 11+                                              | Meter list (bands in order)                                                              | 10 per band    | now (current size), exact with C2 |
| P4  | **Age when answered**                                                             | How old is a thing when he replies or closes it? | resolution `at` − `first_seen_at`, by outcome                                     | Box-free: median + p25–p75 as a thin range bar per outcome                               | 10 per outcome | now                               |
| P5  | **Snooze habits** · _"'Waiting on them' woke on activity 64% of the time."_       | How long do snoozes last, how do they end?       | snooze/unsnooze pairs; `meta.bucket`, `meta.cause` (reuse `habits.snoozeBuckets`) | Meter list per bucket (woke on activity / fallback / by hand) + median duration          | 10 snoozes     | now                               |
| P6  | **Undo corner** · _"Ctrl+Z: used 7 times. Nobody's perfect."_                     | How often does he change his mind?               | `undo` events, user                                                               | Stat tile                                                                                | 1              | now                               |

### Backlog

| #   | Card                                                                     | Question                                 | Source                                                                                       | Figure                                                                             | Min                | Status                                        |
| --- | ------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------ | --------------------------------------------- |
| B1  | **Inbox by age**                                                         | How old is what's waiting now?           | `items` `state='inbox'`, not snoozed, not muted, age from `COALESCE(woke_at, first_seen_at)` | Ranked-order bars over bands <1d, 1–7d, 1–4w, 1–3m, 3m+ (one hue, neutral, no red) | 1                  | now (ignores range)                           |
| B2  | **The elder** · _"Waiting patiently since March. It's fine. It's fine."_ | Oldest waiting item                      | B1 max age                                                                                   | Stat tile + link                                                                   | 1                  | now                                           |
| B3  | **Snoozed now**                                                          | What is parked, and for how long so far? | `snoozed_until` not null, `snoozed_at`, `snooze_bucket`                                      | Meter list per bucket: count + median days parked                                  | 1                  | now                                           |
| B4  | **Backlog over time**                                                    | Is the inbox growing or shrinking?       | Inbox replay (RPG §5)                                                                        | Single line, one series                                                            | 14 days of history | now (shares RPG slice 5's replay; build once) |

### Predictions

| #   | Card                                                                                                  | Question                                | Source                                                                  | Figure                                                                 | Min             | Status              |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------- | ------------------- |
| M1  | **How often the robot was right** · _"Agreed with you 78% of the time (n=212). Not bad for a robot."_ | Overall agreement                       | `habits` `suggestionHits` logic (single actions; legacy done ambiguous) | Hero number + n                                                        | 30 judged       | now                 |
| M2  | **By suggestion**                                                                                     | Which suggestion is most reliable?      | per `suggested`                                                         | Meter list reply / act / skip / spam                                   | 10 per row      | now                 |
| M3  | **Calibration** · _"'High confidence' means it, mostly."_                                             | Does confidence track accuracy?         | per `suggestedConfidence`                                               | Meter list low / medium / high, n per row; a footnote if high ≤ medium | 10 per level    | now                 |
| M4  | **Where it trips**                                                                                    | Most common suggested → actual mismatch | confusion matrix suggested × outcome                                    | Small table (4×5), cells shaded one sequential hue, counts printed     | 30 judged       | now                 |
| M5  | **Overridden categories** · _"It thinks 'thanks!' needs a reply. You disagree."_                      | Which categories does he overrule most? | mismatches by category                                                  | Ranked bars of override rate, n per row                                | 10 per category | C1 (approx. before) |
| M6  | **Whose turn**                                                                                        | Was "your turn" right?                  | `suggestedTurn` vs replied/not                                          | Meter list matt / them / nobody                                        | 10 per row      | now                 |

### Fun extras

| #   | Card                                                          | Source                                                                                                                                                                    | Figure              | Min                                         | Status             |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------- | ------------------ |
| F1  | **Busiest day ever** · _"14 Oct: 93 things. You survived."_   | user actions by local date (bulk counted once per action)                                                                                                                 | Stat tile           | 1 day                                       | now                |
| F2  | **Quietest hour** · _"Nothing ever happens at 4am. Respect."_ | R1, min hour with ≥1 week of data                                                                                                                                         | Stat tile           | R1 min                                      | now                |
| F3  | **Biggest thread cleared**                                    | max thread size among items he replied/done                                                                                                                               | Stat tile + link    | 1                                           | now (current size) |
| F4  | **Your week in one sentence**                                 | template over this range's top numbers: _"You answered 23 things, mostly PRs, mostly before lunch; compiler-explorer was the loudest and the robot agreed 4 times in 5."_ | One line at the top | ≥10 actions, else _"A quiet week. Lovely."_ | now                |
| F5  | **Polyglot days**                                             | days with a reply on both YouTube and GitHub                                                                                                                              | Stat tile           | 1                                           | now                |

F4 is deterministic text from a handful of templates chosen by which numbers clear their minimums; no LLM.

## 4. Layout on Stats

- **Order**: F4 sentence → range selector → Rhythm → Responses → Predictions → Sources → Backlog → Fun extras → the
  existing video totals → Usage → (RPG Hall). Insights lead because they are what changes week to week.
- **Range**: segmented `7d · 30d · 90d · All` in the section header, styled like Usage's `7 days / 30 days`. Default
  30d, remembered in `localStorage` (try/catch). Backlog cards (B1–B3) ignore the range and say "right now".
- **Cards**: `.panel` blocks in a `repeat(auto-fill, minmax(300px, 1fr))` grid; heatmaps span the full row. Under
  640px: one column, heatmaps become 24 rows × 7 columns (hours down the page) so cells stay ≥ 12px; tap a cell or
  bar for its value in a single shared caption line under the chart.
- **Low data**: a card under its minimum keeps its title and shows _"Not enough data yet (12 of 50)"_ in muted text, no
  chart. A whole group with nothing collapses to one line. Empty DB: one EmptyState, _"Insights appear once things
  arrive and you deal with them."_
- **Charts**: hand-built CSS like `UsagePanel.svelte` (`.bars`, `.days`, `.stack`). No chart library: the forms are
  bars, meters, a segmented bar, a CSS-grid heatmap and one line (an inline SVG polyline). Shared pieces move into
  `web/src/components/insights/` (`RankedBars`, `MeterList`, `SegBar`, `Heatmap`, `StatTile`).
- **Colour**: add `--viz-*` tokens to `tokens.css` for both `[data-theme]` blocks. Sequential (heatmaps, M4): one
  blue ramp from the dataviz reference (`#cde2fb → #104281` light, stepped separately for dark), never the red accent,
  which reads as alarm. Outcome split (P1, the only categorical use): replied `#2a78d6`, done `#eb6834`, dismissed
  `#1baf7a`, snoozed `#eda100` (dark: `#3987e5 #d95926 #199e70 #c98500`); legacy/upstream in neutral grey. Validated
  with the dataviz script against `--bg-elev`: all gates pass in both modes; light mode warns on contrast for aqua and
  yellow, so the segmented bar always carries a legend with values, and every chart has a "Show as table" toggle.
  Text stays in text tokens, never series colours.
- **Accessibility**: each chart `role="img"` with an `aria-label` summarising it; the table toggle is the full data.

## 5. API and server

- `GET /api/insights?range=7d|30d|90d|all&tz=Europe/London` → `Insights`. `tz` validated by constructing an
  `Intl.DateTimeFormat`; invalid → 400. Web sends `Intl.DateTimeFormat().resolvedOptions().timeZone`. Route in
  `server/routes/insights.ts`, behind the existing auth like `/api/usage`. Demo mode serves the same code over the demo DB.
- **DTO** in `shared/types.ts`: `Insights { range; tz; generatedAt; sentence: string | null; rhythm; sources;
responses; backlog; predictions; extras }`. Every card is `{ n: number; min: number; data: … | null }` so "not enough
  data" is decided on the server once, and the client only renders. Names/titles appear only in S1–S5, B2, F3.
- **Compute**: `insightsReport(db, { range, tz, now })` in `server/db/insights.ts`, one ordered pass over
  `item_events` (range-filtered via `idx_item_events_at`, plus earlier rows for items in range so first-action and
  undo matching work) joined to `items`, then a few aggregate queries over `items`/`threads`/`videos`. Extract the
  helpers `habits.ts` already has (`parseMeta`, `median`, `LEGACY_DONE`, `AGREES`, bulk detection, undo matching) into
  `server/db/history.ts`, shared by habits, insights and rpg, so all three agree on what counts as a hit or a bulk action.
  Local hour/date via one cached `Intl.DateTimeFormat(…, { timeZone: tz, hourCycle: 'h23' }).formatToParts` per request.
- **Cache**: in-memory map keyed by `range|tz|MAX(item_events.id)|MAX(items.rowid)|local date`, max 8 entries.
  `items` rows change without events (refreshed comment counts), so entries also expire after 5 minutes.
- **Tests** (`insights.test.ts`, fixtures built like `habits.test.ts`):
  - empty DB and pre-migration-11 DB: every card `data: null`, no throw;
  - thresholds: one below / at min flips `data`;
  - undo cancels an outcome; bulk actions excluded from rates but counted in rhythm; legacy done kept ambiguous;
  - import filter: an item with `first_seen_at` a year after `occurred_at` is not an arrival;
  - timezones: same events under `UTC`, `Europe/London` and `America/Los_Angeles` land in different hours;
    DST spring-forward (no 01:00 local) and fall-back (01:00 twice) days count correctly, and weekday normalisation
    counts calendar days, not 24h blocks;
  - read-only: runs against a database file reopened read-only (better-sqlite3 `readonly: true`); `/api/inbox`
    output identical before and after a call;
  - privacy: output contains no item body text (seed `'SECRET TITLE'`-style bodies and assert absence).
  - Web: vitest for the sentence templates, size-band and age-band formatting, and the low-data states.

## 6. Implementation slices

Each ships alone, in this order.

1. **Capture C1 + C2.** Two meta keys in `events.ts` / `triage()`, with tests. Ships first because history can't be
   backfilled; every day without it is lost data.
2. **Core + Rhythm.** `history.ts` extraction (habits tests stay green), `insights.ts` with R1–R4, DTO, route, cache,
   tz tests; `InsightsPanel.svelte` with the range selector, `Heatmap`, low-data states, `--viz-*` tokens.
3. **Responses + Predictions.** P1–P6, M1–M6 (M5 approximated until C1 has data), `MeterList`, `SegBar`, table toggle.
4. **Sources + Backlog (now).** S1–S6, B1–B3, `RankedBars`, `StatTile`, item links.
5. **Extras + sentence.** F1–F5 and the F4 templates.
6. **Backlog over time (B4).** Lands with or after RPG slice 5's inbox replay; whichever ships first builds it in
   `history.ts`.

## 7. Open questions

1. **Should bulk actions count anywhere?** Recommend: yes in rhythm (they are work done at that hour), never in rates
   or prediction accuracy.
2. **Show commenter names in "Regulars", or only counts?** Recommend names, top 5, own and bots excluded: it is what
   the inbox already shows, and it is the fun part.
3. **Arrival time: when Nudge saw it, or when it was written?** Recommend `first_seen_at` for "when the world writes
   to you" (that is when it lands) with `occurred_at` as a second view in the card's table; they differ only by sync lag.
4. **Should insights cover archived/muted items?** Recommend no: they never reached the inbox, so they say nothing
   about his triage. Muted volume could be a single line in S1 later.
5. **Default range?** Recommend 30d: 7d is too sparse for most minimums, "All" is dominated by the backfilled era.
