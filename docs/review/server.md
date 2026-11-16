# Server review (server/ and shared/)

Read-only housekeeping review of the server side as of commit `770cf26`. Scope: `server/**` and `shared/**`
(about 19,000 lines of source and 70 test files). `tsc -p server --noEmit` is clean and all 1003 server/shared
vitest tests pass. Nothing was edited, no e2e run, nothing touched outside the repo.

## Verdict

The server is in better shape than most personal tools: the composition root injects clocks, fetch and fakes almost
everywhere, the security model is explicit and unit tested, every state change writes its history row in the same
transaction, layering is mostly respected (`shared/` imports nothing upward, `db/` only takes types from `classify/`,
and there are boundary tests for Insights and Adventure mode), and risky flows such as reply posting and the Access
JWT check are carefully written. The problems are of three kinds. First, a handful of real correctness and safety
gaps: the daily LLM spend cap silently stops working for any model not in a two-entry price table, the assistant puts
untrusted item titles straight into a tool-calling prompt, the Tailscale identity check can probably be skipped with a
loopback `Host`, and background-task failures in the snooze route are logged to a logger that is switched off. Second,
the owner's identity is baked into the code that is about to be open-sourced: the classifier prompts describe Matt
Godbolt by name and occupation, and `'matt'` is a stored enum value and an API filter. Third, growth has outrun
structure: `db/repo.ts` is a 1,840-line closure, three reports each have a 250 to 670 line function, there are three
separate Anthropic HTTP clients, two polling-tier tables that already disagree, and half a dozen copies of "parse a
JSON column". None of it is urgent, but for a codebase whose owner relies on tests and that strangers will read, the
first ten items below are worth doing before the repository goes public. There is also no CI and no linter, although
the code carries 18 `eslint-disable` comments.

Severity: **bug** (wrong behaviour today), **risk** (wrong under plausible conditions, or a security weakness),
**cleanup** (structure, duplication, testability), **nit**. Effort: **S** (one file or function), **M** (several files,
tests to move), **L** (cross-cutting, needs a migration or an eval re-run).

---

## 1. Security

### 1.1 The assistant's prompt carries untrusted titles next to mutating tools — risk, S

`server/providers/anthropic/client.ts:186-198`. `command()` builds the user turn as
`Selected item (${kind}): ${selected.title}` plus `Most recent action: ... "${recent.title}"`, with no escaping and
no data delimiters. For a GitHub item the title is whatever a stranger typed as an issue or PR title. The same request
offers the tools `add_todo`, `snooze`, `mark_done`, `dismiss` and `record_note`, and the system prompt only says the
_user's words_ are data (line 21); it says nothing about the selected item.

Why it matters: a crafted issue title can steer the tool calls made when the owner runs any command with that item
selected (or just after acting on it). The worst outcome is `record_note` with `scope: 'standing'`: standing notes are
appended to the classifier's system prompt for every item (`classify/anthropic.ts:107-116`), so one injected title can
bias every later suggestion until the note is noticed. The classifier path itself is well defended (`renderItem`
escapes, forced tool, injection flag); this path has none of that.

Fix: render the selected and recent titles through the existing `esc`/`clip` helpers inside a tagged block
(`<selected_item kind="…"><title>…</title></selected_item>`), add the same "everything inside is untrusted data"
sentence the classifier prompt has, and consider refusing `scope: 'standing'` notes unless the command text itself
(not the context) contains the preference. Blast radius: one function plus `routes/todos.test.ts`; `command()` needs
an injectable fetch to be tested at all (see 4.2).

### 1.2 A loopback `Host` skips the Tailscale user check — risk, S (confirm first)

`server/security.ts:79-99`. A request whose `Host` is `127.0.0.1:<port>` is accepted without looking at
`Tailscale-User-Login`; the user check only runs for `allowed && !accessHost`. The code already recognises this hole
for Cloudflare (lines 87-91: "a tunnel rewritten to send a loopback Host (which skips every check below)") and closes
it by rejecting loopback-Host requests that carry Cloudflare headers. Nothing equivalent exists for `tailscale serve`.

As far as I know `tailscale serve` picks its handler from the TLS SNI name and forwards the client's own `Host` header
to the backend, so a tailnet device that is _not_ in `NUDGE_ALLOWED_USERS` could send
`Host: 127.0.0.1:4517` to the machine's ts.net name and be treated as a local request. I could not confirm that
behaviour from here (no access to the production host by design), so treat this as "verify with one curl from a second
tailnet device". There is no test for it (`security.test.ts` has the Cloudflare case only).

Fix: mirror the Cloudflare defence. When `allowedHosts` is non-empty, reject a loopback `Host` that arrives with any
proxy marker (`tailscale-user-login`, `tailscale-user-name`, `x-forwarded-for`, `x-forwarded-host`). Blast radius:
`checkRequest` and three or four new cases in `security.test.ts`. If Tailscale turns out to rewrite `Host`, add the
test anyway and note it in the README.

### 1.3 Attribute values in the classifier prompt are not quote-escaped — risk, S

`server/classify/anthropic.ts:44` (`esc` handles `& < >` only) and lines 53, 63: `kind="…"`, `author_type="…"`,
`association="…"`, `labels="${esc(g.labels.join(', '))}"`. A GitHub label name may contain `"`, which closes the
attribute and lets the label text add attributes to the `<github>` element. It cannot open a new tag, so the damage is
small, but the comment above `renderItem` claims "nothing a commenter writes can close a tag or open a new one" and
labels are set by whoever can label in a followed repository. `classify/snooze.ts:85,99` has the same shape.

Fix: escape `"` (and `'`) in `esc`, or move labels into element content. This changes rendered prompts, so
`PROMPT_VERSION` must be bumped (one re-classification of the inbox). Blast radius: one helper, a few snapshot-style
assertions in `classify/anthropic.test.ts`.

### 1.4 Things that are fine, for the record

Host/Origin/`X-Nudge` checks (`security.ts`), the hand-written RS256 verifier (`auth/access.ts`: alg pinned, kid
refetch throttled, issuer/audience/exp/nbf checked, fail closed), OAuth state + PKCE (`auth/google.ts`), the push
endpoint allow-list (`push/sender.ts:8-24`, the only place a client-supplied URL is fetched), the GitHub client (fixed
host, every path segment through `encodeURIComponent`), FTS query building (`repo.ts:137-141`), and secrets in DTOs
(`routes/util.ts:56-88` sends only `last4`). All SQL is parameterised; the interpolated fragments are constants.
`PUT /api/settings` accepts a YouTube `apiKey` of any length (`routes/api.ts:417-420`) while the GitHub and Anthropic
keys are capped at 300: nit.

---

## 2. Bugs and correctness risks

### 2.1 The daily LLM cap does not bite for any model missing from `PRICES` — bug, S

`server/classify/anthropic.ts:146-159`: `costMicros` returns 0 for a model that is not one of the two keys in
`PRICES` (`claude-haiku-5-5`, `claude-sonnet-5-5`). `PUT /api/settings` accepts any id matching `[\w.:-]{3,80}`
(`routes/api.ts:89-93`). Every caller derives spend from `costMicros` (`suggest/worker.ts:273`, `routes/snoozeAi.ts:23`,
`routes/todos.ts:81-83`), so with a dated id, an Opus model or a typo the recorded spend is $0 and
`DAILY_CAP_USD` ("a constant on purpose: a runaway loop must not be fixable by a setting",
`suggest/worker.ts:18-19`) never triggers. The behaviour is even pinned by a test
(`classify/anthropic.test.ts:221`, "is zero for an unknown model rather than guessing").

Fix: make an unknown model fail safe. Either reject models without a price in the settings validator, or price
unknown models at the most expensive known rate (and match by prefix so dated ids resolve). Blast radius:
`costMicros`, the settings validator, two tests.

### 2.2 The cap's ledger is spread over three places and one of them is erasable — risk, M

- Suggestion spend is `SUM(cost_usd)` over the _current_ `suggestions` rows since UTC midnight
  (`db/suggestions.ts:270-277`). A row is replaced when an item is re-classified and deleted with its item
  (`ON DELETE CASCADE`), so the sum under-counts; `memSpend` in `suggest/worker.ts:151-178` papers over that only until
  the next restart.
- Snooze-AI spend lives in `usage_daily` under `snooze_ai.cost_micros`. `DELETE /api/usage` ("Reset usage data",
  `routes/usage.ts:33`, `db/usage.ts:70-72`) wipes it, and the migration comment calls that table "safe to delete
  wholesale".
- Assistant spend (`assistant.cost_micros`) is recorded but never counted toward the cap, and `/api/assistant` checks
  no cap at all (`routes/todos.ts:61-90`). `spentTodayUsd` (`routes/snoozeAi.ts:17-19`) and the worker's
  `spentToday` (`suggest/worker.ts:168-174`) are two copies of the same sum and both omit it.

Fix: one append-only `llm_spend(day, purpose, micros)` table (or three protected keys excluded from the usage reset)
behind one `spentTodayUsd()` used by the worker, the snooze calls and the assistant. Blast radius: a small migration,
`worker.ts`, `snoozeAi.ts`, `todos.ts`, their tests.

### 2.3 Background failures in the snooze route go to a logger that is off — bug, S

`server/app.ts:35` creates Fastify with `logger: false`, so `req.log` is a no-op. `routes/api.ts:224-229` passes
`(msg, err) => req.log.warn({ err }, msg)` to `recordSnoozeContext` and `bucketInBackground`, and
`routes/snoozeAi.ts:115` logs a failed comment fetch the same way. Those failures are therefore invisible, while the
same `bucketInBackground` called from `routes/todos.ts:134` logs through `console.warn`. Fix: use one logging function
(a `log` member on `AppDeps`, defaulting to `console.warn`) in all four places. Blast radius: three call sites.

### 2.4 Two polling-tier tables that already disagree — bug (small), S

`server/sync/tiers.ts` is what the engine uses; `server/db/tiers-lite.ts` is a copy the repo uses for the tier shown
in the UI and for `projectedUnitsPerDay` (`repo.ts:270`, `repo.ts:554`). The copy's own header says it "should be
reconciled with (or import) this file". They differ for a video with no publish date: `tiers.ts:29` says `cold`,
`tiers-lite.ts:32` says `warm`, so such a video is displayed as warm and budgeted at 24 units a day while it is polled
as cold (2 a day). Fix: delete `tiers-lite.ts`, move the table to `shared/` or let `db/` import `sync/tiers.ts`
(it is dependency-free), keep `unitsPerDay` next to it. Blast radius: two imports and `db/text.test.ts`, which is
where the tiers-lite tests currently live.

### 2.5 A truncated GitHub poll can stop advancing — risk, S

`server/sync/github.ts:62-64, 83, 109-111`. When a query hits the page cap the cursor becomes the newest `updatedAt`
seen and `nextPollAt` is "now". The next poll subtracts `OVERLAP_MS` (15 minutes) from that cursor. If one owner has
500 or more PRs (or issues) updated inside one 15-minute window (a bulk relabel, a bot sweep, a repository transfer),
the re-read window contains the same 500 rows, the cursor lands on the same value, and the feed re-polls every tick
without ever reaching newer items. The existing truncation tests (`sync/github.test.ts:145-162`) use spread-out
timestamps. Fix: when resuming from a truncation, do not apply the overlap (store a "resume" flag with the cursor), or
raise the page budget when a poll made no progress. Blast radius: `pollFeed` and one test.

### 2.6 "Was the newest comment mine?" fails open — risk, S

`server/sync/github.ts:91-103` looks up the latest commenter for at most 10 items per poll and swallows lookup errors
(`.catch(() => null)`). `db/feeds.ts:493-499` then reopens a Done item whenever `lastCommenterIsMe !== true`, which
includes "not looked up". The new comment count is stored in the same upsert, so the question is never asked again.
Result: after a burst (or during a GitHub hiccup) the owner's own comments bring his Done items back to the inbox.
Fix: carry an explicit tri-state (`me | them | unknown`) and, for `unknown`, leave the stored count untouched so the
next poll retries. Blast radius: `GithubItemUpsert`, `upsertGithubItems`, a test in each of the two files.

### 2.7 Background loops have no safety net — risk, S

- `server/sync/github.ts:151-158`: `chain = chain.then(async () => …)`. If the callback ever rejects, `chain` stays
  rejected and every later `run()` returns that rejection without polling. `pollFeed` catches GitHub errors, but
  `repo.getSettings()` (line 46), the `recordFeedPoll` inside the `catch` block (line 141) and `announceFeeds()` (line 148) are outside or after the `try`.
- `tick()` is started with `void tick()` (line 171/173), as are the scheduler's (`sync/scheduler.ts:40-42`) and the
  suggestion worker's `drain()` (`suggest/worker.ts:236`). `server/index.ts` installs no `unhandledRejection` handler,
  so an escaped rejection terminates the process (Node's default) and relies on Docker's `restart: unless-stopped`.

Fix: `chain = chain.catch(() => undefined).then(…)`, a `.catch(log)` on each `void`ed loop, and a process-level
handler that logs and exits deliberately. Blast radius: four lines and a test that a throwing poll does not stop the
next one.

### 2.8 `PUT /api/settings` recomputes YouTube ownership twice — cleanup, S

`repo.updateSettings` already calls `recomputeOwnership` when `ownChannelIds` changes (`db/repo.ts:186-188`); the
route then calls it again (`routes/api.ts:471-472`). Each call is five full-table `UPDATE`s with event recording.
Delete the route's call.

### 2.9 Smaller items

- `server/youtube/client.ts:152` and `testKey` (line 317): the only outbound `fetch` calls without
  `AbortSignal.timeout`. Undici's five-minute default applies, during which the single-queue sync engine and
  `engine.status().running` are stuck. Cleanup, S.
- `server/sync/engine.ts:350` and `:424`: the "key was rejected" block compares `repo.getSettings().apiKey` only. A bad
  key from `YOUTUBE_API_KEY` or `~/.nudge-key` records `apiKey: null`, so fixing the key file does not resume
  background polling until a manual sync or restart. Use `deps.resolveApiKey`. Risk, S.
- `server/db/repo.ts:1277-1287`: triage to `inbox` clears a snooze, but `undo` does not put it back (the action stores
  no snooze fields), and when the state did not change nothing is stored at all. Nit unless it is noticed in use.
- `server/db/db.ts:62-63` snapshots with `VACUUM INTO`, while `migrations.ts:57-58` and `:225-226` say "Never VACUUM
  this database" because the FTS index is keyed on the rowid of a table without an integer primary key. I checked
  with the bundled SQLite (3.53.4): `VACUUM INTO` kept the rowids and search still worked in the copy, so nothing is
  broken today, but SQLite documents that as not guaranteed and the nightly backup (`deploy/backup-db.mjs`) uses the
  page-level backup API instead. Either switch the snapshot to the backup API or soften the comment and add a test
  that searches a restored snapshot after deletions. Nit, S.
- `server/db/events.ts:28-29` says earlier events "are never edited or deleted", yet `mergeSnoozeMeta` (line 230) and
  `assignSnoozeBucket` (`repo.ts:1488`) rewrite an event's meta. Say so in the header. Nit.
- `server/sync/snooze.ts:17` ("stored on the comments") and `server/db/usage.ts:22` ("Prepared lazily") describe code
  that has since changed. Nit.
- `wakeOnActivity` (`db/wake.ts:36`) and `wakeSnoozed` (`repo.ts:1616`) leave `snooze_until_activity = 1` on a woken
  row. Readers all guard on `snoozed_until`, so it is harmless, but it is a stale flag waiting for a reader that does
  not. Nit.

---

## 3. Open-source readiness

### 3.1 The owner is hard-coded into prompts, enum values and identifiers — cleanup, L

- `server/classify/anthropic.ts:11-24`: the system prompt begins "You triage the inbox of Matt Godbolt, creator of
  Compiler Explorer, who also runs a YouTube channel about C++…". `classify/snooze.ts:18` (nudge drafts) and
  `anthropic.ts:111` (owner notes) do the same. Anyone else who adds an Anthropic key gets their items triaged as if
  they were Matt.
- `'matt'` is a value, not just a name: `TURNS = ['matt', 'them', 'nobody']` (`classify/types.ts:72`), the stored
  `suggestions.turn` column, `suggestedTurn` in `item_events.meta`, the public filter
  `SUGGESTION_FILTERS` (`shared/api.ts:3`), `SuggestionDTO.turn` (`shared/types.ts:150`), SQL in `repo.ts:1110`, and
  the prompt attributes `is_matt` / `from="matt"` (`anthropic.ts:68,76,89`), plus `isMatt` fields in
  `classify/types.ts:47`, `routes/snoozeAi.ts:98,110` and `suggest/worker.ts:338`. 24 occurrences in non-test source.
- Comments across `db/` and `routes/` refer to the owner as "he"/"his".

Fix: an owner profile in settings (display name plus a one-paragraph "who I am and what I maintain") interpolated
into the three prompts, and rename the enum to `me | them | nobody` (`is_owner` in the prompt). This changes rendered
prompts, so it needs a `PROMPT_VERSION` bump and a re-run of the offline eval; stored `turn` values and history meta
need either a small migration or a read-side alias. Blast radius: classify/, suggest/, shared types, the web filter,
demo fixtures, about a dozen tests.

### 3.2 Legacy and undocumented configuration — cleanup, S

- The pre-rename `YOUTUBEY_*` fallbacks (`config.ts:34-42`, `migrateLegacyDb` at `:47-53`, `index.ts:201`) only
  ever served one installation. Remove them before publishing, or mark them with a removal note.
- `server/index.ts` reads eight variables directly from `process.env` instead of through `loadConfig`:
  `NUDGE_DEMO_SUGGEST`, `NUDGE_DEMO_HISTORY`, `NUDGE_DEMO_COMMENTS`, `NUDGE_DEMO_BACKLOG`,
  `NUDGE_DEMO_SUGGEST_CAP_AFTER`, `NUDGE_DEMO_BUILD_ID`, `NUDGE_DEMO_GITHUB`, `NUDGE_WEB_DIR`. Only
  `NUDGE_DEMO_GITHUB` is in the README table; `GIT_SHA` and the effect of `NODE_ENV` (see below) are not either.
- `server/app.ts:29-31`: the Vite dev origins are trusted unless `NODE_ENV === 'production'`. The Dockerfile and
  `npm start` set it; a bare `node dist/server/server/index.js` does not, so the permissive setting is the default.
  The `X-Nudge` header still blocks cross-site requests, so this is defence in depth only, but the default should be
  the strict one (trust dev origins only when `NODE_ENV === 'development'` or the server runs under `tsx watch`).

### 3.3 No CI, no linter, no coverage — cleanup, M

There is no `.github/workflows`, `npm run lint` is Prettier only, and no coverage provider is configured in
`vitest.config.ts`. The code carries 18 `eslint-disable` comments for a linter that is not installed, including a
file-wide one at `db/repo.ts:1`. For an owner who relies on tests, the missing piece is something that runs them on
every push: one workflow with `npm run typecheck`, `npm run lint`, `npm test` and the Playwright suite, plus
`@vitest/coverage-v8` so the gaps in section 6 are numbers rather than a reading exercise. Either add typescript-eslint
(the `no-explicit-any` and `no-floating-promises` rules would have flagged 2.3 and 2.7) or delete the dead comments.

---

## 4. Duplication that wants one abstraction

### 4.1 Three Anthropic HTTP clients — cleanup, M

`classify/anthropic.ts:186-254` (retries, `ClassifierError`), `classify/snooze.ts:53-71` and
`providers/anthropic/client.ts:87-105` (the last two are the same function, `LlmError`). The API URL, version header,
timeout, error mapping and usage parsing are written three times (`tokensOf` in `snooze.ts:33-42`, inline in
`client.ts:157-171`, inline in `anthropic.ts:230-238`), and the "forced tool only for haiku" heuristic twice
(`anthropic.ts:204`, `snooze.ts:81`). Only two of the three accept an injected `fetch`.

Fix: one `providers/anthropic/transport.ts` exporting
`createAnthropic({ fetchImpl, sleep }) → { messages(apiKey, body, { retries }) → { content, usage } }` with one error
class carrying `status`; the classifier, snooze calls and assistant become prompt-and-parse modules on top. The cap
check from 2.2 can then sit in the transport, where it cannot be forgotten. Blast radius: three modules and their
tests; no behaviour change intended.

### 4.2 "Parse a JSON column into an object" — cleanup, S

`parseData` in `db/feeds.ts:565-573`, another `parseData` in `db/suggestions.ts:99-106`, `json()` in
`db/notes.ts:51`, `parseMeta` in `db/history.ts:33-41`, two inline versions in `db/events.ts:178-183` and `:238-244`,
and `getVapidKeys` in `db/repo.ts:241-250`. They differ in whether an array counts as an object. One helper in
`db/json.ts`, typed as `Record<string, unknown>` rather than `any`.

### 4.3 History reading: `habits.ts` does not use the shared readers — cleanup, M

`db/history.ts` was extracted so that "the habits report, Adventure mode and Insights … all three agree on what a
meta blob says, what an undo cancels, what counts as a bulk action" (its header, lines 3-7). `rpg.ts` and
`insights.ts` use `loadEvents`, `undoIndex`, `bulkIndex` and `resolutionOf`. `habits.ts` imports only `AGREES`,
`DECISION_WINDOW_MS`, `LEGACY_DONE`, `median` and `parseMeta`: it runs its own SQL (`habits.ts:125-131`), classifies
actions itself (`:172-197`), has its own bulk detection (`actionSize`/`decisionsOf`, `:159-162`, `:319-321`) and does
not consult undos at all, so an undone action still counts in its hit rates while Insights excludes it. Either port
`habitsReport` onto the shared readers or, since Insights now answers the same questions in the product, retire the
script (`scripts/report-habits.ts` is its only caller) and say so in `docs/INSIGHTS.md`.

### 4.4 "Is this item in the inbox and not snoozed?" — cleanup, S

The predicate `state = 'inbox' AND (snoozed_until IS NULL OR snoozed_until <= now)` is written out in
`db/repo.ts:993` (`NOT_SNOOZED`, used six times), `db/feeds.ts:90-91`, `db/suggestions.ts:171-172` and `:286-287`, its
negation in `db/wake.ts:31-32`, `db/feeds.ts:311` and `:401-406`, and again in JavaScript in `repo.ts:100`, `:1040`,
`:1043` and `:1416`. Export the SQL fragment and one `isSnoozed(row, at)` function from a small `db/snooze-sql.ts`.
The same goes for the mute predicate, which exists as SQL (`MUTED_SQL`, `feeds.ts:23-29`) and as JavaScript
(`muteHit`, `feeds.ts:339-347`) that must be kept in step by hand.

### 4.5 Own-channel bookkeeping — cleanup, M

`sync/own-channels.ts` calls itself "the single place that keeps `ownChannelIds` … in step with a channel source's
`isOwn` flag", but it only does one direction. The other direction (ids changed, so flip `sources.is_own`) is
hand-written in `routes/api.ts:345-347`, `:474-478` and `:524-527`, with further callers of `setOwnChannelId` in
`sync/sources.ts:56,81`, `auth/google.ts:233` and `reply/poster.ts:195`. One repo method
`setChannelOwnership(channelId, own)` that updates the setting, the source flag and comment ownership in one
transaction would remove the three route copies and 2.8.

### 4.6 Route boilerplate and constants — cleanup, S

- `YtError → HttpError` mapping twice (`routes/api.ts:323-326`, `:509-512`); the id-array validation twice
  (`:163-165` inline, `idList` at `:97-102`); `emitInbox` defined in `api.ts:107`, `github.ts:17` and `todos.ts:34`;
  `emitFeeds` in `routes/github.ts:16` and `announceFeeds` in `sync/github.ts:42`.
- `req.body === undefined || req.body === null ? {} : asObject(req.body)` appears six times; add `optionalObject()`
  to `routes/util.ts`.
- `routes/github.ts` parses ids with bare `Number(req.params.id)` (lines 90, 108, 115, 138) while every other route
  uses `int()`.
- Constants defined more than once: `IMPORT_MODES` (`routes/api.ts:22`, `routes/github.ts:8`), `MUTE_KINDS`
  (`db/feeds.ts:18`, `routes/github.ts:9`), `WHY_MAX` (`routes/api.ts:19`, `providers/anthropic/client.ts:10`),
  `TITLE_MAX` (`routes/todos.ts:12`, `client.ts:7`), `NOTE_TEXT_MAX` (`db/notes.ts:9`, `client.ts:11`), `DAY_MS` in six
  files, `EPOCH` twice, `dayOf`/`dayStart` three times. The unions (`ImportMode`, `MuteKind`, `PollTier`, `Theme`,
  inbox views, audiences, orders) should each be a `const` array in `shared/` with the type derived from it, so the
  validators in `routes/api.ts:141-146` stop restating them as literals.

---

## 5. Structure, layering and size

### 5.1 Largest files and functions

| Where                                         | Size                                                       | Split?                                                              |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `db/repo.ts` `createRepo` (143-1977)          | about 1,840 lines, one closure, 90 `db.prepare` call sites | Yes, see 5.2                                                        |
| `db/insights.ts` `insightsReport` (284-957)   | about 670 lines                                            | Yes: one function per card over a shared, pre-loaded context        |
| `routes/api.ts` `registerApiRoutes` (104-562) | about 460 lines, nine route groups                         | Yes: triage/snooze, drafts/reply, sources, sync, settings           |
| `db/rpg.ts` `rpgSheet` (245-650)              | about 400 lines                                            | Yes: XP, achievements, campfire and bosses already read as sections |
| `server/index.ts` `main` (55-323)             | about 270 lines                                            | Yes: lift the demo wiring into `demo/compose.ts`                    |
| `db/habits.ts` `habitsReport` (124-373)       | about 250 lines                                            | See 4.3                                                             |
| `db/feeds.ts` `upsertGithubItems` (325-506)   | about 180 lines                                            | Extract the per-item decision as a pure function                    |
| `routes/api.ts` `PUT /api/settings` (414-495) | about 80 lines                                             | Move merge and side effects into a settings service                 |
| `suggest/worker.ts` `pass` (357-474)          | about 120 lines                                            | Acceptable; `lane` could be lifted out                              |
| `server/contracts.ts`                         | 826 lines; `Repo` has about 100 members                    | Split by concern alongside 5.2                                      |

### 5.2 `db/repo.ts` is a god object, half refactored — cleanup, L

Newer areas are already separate stores reached through a namespace (`repo.usage`, `repo.suggestions`, `repo.notes`,
`repo.clientEvents`), feeds and todos are separate files but spread flat onto the repo object (`repo.ts:1875-1879`),
and everything older (settings, push subscriptions, videos, sources, threads and comments, inbox listing, triage,
snooze, drafts, Google accounts, reply posts, quota, sync runs) lives in the one closure. Callers cannot tell which
style a method uses, and `Repo` in `contracts.ts:302-490` is one interface that every fake must satisfy.

Suggested end state: `db/` modules per concern (`settings`, `push`, `youtube` (videos, sources, threads), `inbox`
(list, counts, DTO mapping), `triage`, `snooze`, `accounts`, `quota`), each a `createX(db, clock, events)` returning a
small interface, composed in `createRepo`. Consumers then take `Pick`-style slices, which several already do
(`config.ts:100`, `push/sender.ts:27`). It can be done one concern at a time with no behaviour change; snooze is the
best first candidate because its logic is currently split between `repo.ts:1374-1624`, `db/wake.ts` and
`db/feeds.ts`.

Two smaller things in the same file: statements are prepared inside the functions that run them, including in
per-comment loops (`upsertComment`, `repo.ts:708-761`, prepares up to four statements per comment during a sync);
hoisting them, as `putSetting` already is, is a cheap win on the hot path. And `events.ts:122-139`, `:161-172` carry
try/catch fallbacks for databases "from before migration 11/12" that exist only because some tests build a repo on a
half-migrated database: production code should not carry test scaffolding, so build those test databases with
`migrate()` up to the version under test instead.

### 5.3 Domain logic living in route files — cleanup, M

- `routes/snoozeAi.ts` exports `spentTodayUsd` and `bucketInBackground`, and imports `DAILY_CAP_USD` from
  `suggest/worker.ts`; `routes/snoozeContext.ts` has no routes at all; `routes/notes.ts` exports `recordNote` and
  `announce`; `routes/github.ts` exports the `LOGIN` regex that `routes/api.ts` imports. These are services. A
  `server/snooze/` (context, bucketing, nudge) and a `server/llm/budget.ts` would give them a home.
- `routes/todos.ts` is mostly `/api/assistant` (lines 41-149) plus `/api/settings/test-llm`; the name hides the
  assistant. Split into `routes/assistant.ts` and a small todos route.
- `buildSettingsDto` sits in `routes/util.ts` and is imported by `server/index.ts`.
- `POST /api/mutes` (`routes/github.ts:122-135`) adds a rule and archives the affected items as two repo calls in two
  transactions; `POST /api/snooze` (`routes/api.ts:189-232`) resolves the fallback date, validates the window and
  decides which background jobs to start. Both are the kind of rule that is easier to test below the HTTP layer.

### 5.4 `AppDeps` is shaped by the tests — cleanup, M

`contracts.ts:754-802`: `push`, `github`, `githubClient`, `llm`, `snoozeAi`, `suggest`, `rpg`, `insights`,
`backfillDetails`, `version` and `buildId` are optional, each documented as "absent in tests that do not exercise
it". Production always supplies them, so every `deps.github?.pollNow()`, `if (!deps.snoozeAi)`, `if (!reader) return`
and the 501/503/424 "not available" answers are branches that only tests reach. Make them required and give tests one
`makeTestDeps(overrides)` helper with no-op fakes (there is already `sync/test-helpers.ts`). `suggest.status?` being
optional inside an optional (`routes/api.ts:122,127`) goes away with it.

### 5.5 Type looseness — cleanup, M

- `type Row = Record<string, any>` in seven modules, with DTO mapping done by hand from untyped rows. The mappers are
  where a renamed column would silently become `undefined`; typed row interfaces per query (as `db/history.ts:145-154`
  and `db/wake.ts:34` already do) would let the compiler check them.
- Stringly typed values that have a closed set: `PassResult.stopped` (`suggest/worker.ts:98-99`, documented as five
  literals but typed `string`), `SuggestionRow.model === 'rules'`, wake `trigger` and item `reason` (`'new'`,
  `'reopened'`, `'new_activity'`, `'muted'`), event `meta` keys (the vocabulary in `db/events.ts:6-64` is prose; a
  discriminated union per kind would let `record()` reject a misspelt key).
- `HistEvent.kind`/`source` are `string` (`db/history.ts:134-143`) although `EventKind` and `EventSource` exist.
- Label events: `EventKind` still includes `label_add`/`label_remove` for a feature dropped in migration 015; fine
  as history, worth a `@deprecated` note on the union members.

---

## 6. Testability and coverage

### 6.1 Hidden clocks and randomness — cleanup, M

The repo, engine, pollers, worker, auth and poster all take a clock; the HTTP layer does not. `routes/api.ts:200,203`,
`routes/itemEvents.ts:52`, `routes/todos.ts:57,120` and `routes/snoozeAi.ts:17` read `Date.now()` or `new Date()`
directly, as do `providers/github/client.ts:195-196` and `providers/github/discussion.ts:56` (which mixes its injected
clock with `Date.parse` of a wall-clock `retryAt`). The visible symptom is `demoControls.advanceDays`
(`index.ts:261-269`), which has to skew the repo clock for exactly one sweep and put it back because the routes would
otherwise disagree with it. Put `clock` on `AppDeps` and pass the same one to `createRepo`. `db/todos.ts:15` uses
`randomUUID()` directly; an injected id source would make todo tests deterministic.

### 6.2 Module-level state

`suggest/worker.ts` keeps `failed`, `threads` and `fetchFailed` maps for the life of the process with no eviction
(lines 154-157); `threads` holds comment text for every GitHub item ever classified. Bound them (the discussion cache
in `providers/github/discussion.ts:50-53` shows the pattern). `sync/engine.ts:71-90` keeps run state in closure
variables (`shouldContinue`, `acc`, `runNewComments`), which is safe only because runs are serialised; worth a
comment saying so.

### 6.3 Coverage gaps found by reading tests against code

| Module                                                              | Gap                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/anthropic/client.ts`                                     | `command()`, `test()` and `call()` have no test and use global `fetch` (not injectable). Only `parseCommand` is tested. The prompt from 1.1 is therefore unpinned.                                                                                                                          |
| `server/index.ts`                                                   | 270 lines of wiring with no unit test; e2e runs demo mode only, so the real-mode branch (`createHttpClient`, `createGoogleAuth`, `redirectUri`, the Access verifier hook-up) is never executed by any test. A `composeApp(config, env)` function returning the deps would make it testable. |
| `server/security.ts`                                                | No case for a loopback `Host` arriving with proxy headers on a Tailscale setup (1.2).                                                                                                                                                                                                       |
| `classify/anthropic.ts`                                             | A test asserts the unsafe behaviour of 2.1; none covers `"` in labels (1.3).                                                                                                                                                                                                                |
| `sync/github.ts`                                                    | Truncation is tested with spread-out timestamps only (2.5); no test for a lookup beyond the cap or a failed lookup (2.6); none for a poll that throws outside the `try` (2.7).                                                                                                              |
| `routes/api.ts`                                                     | No own test file; covered through `routes.test.ts` and friends. The settings merge (lines 442-494) is exercised but the `req.log` paths (2.3) cannot be asserted because the logger is off.                                                                                                 |
| `server/config.ts`                                                  | Only `config.rename.test.ts` (the legacy names). Port validation, `accessHosts` normalisation (lines 72-78) and `resolveGoogleClient` precedence deserve direct cases.                                                                                                                      |
| `db/db.ts`                                                          | Snapshot and migration tests exist; none restores a snapshot and searches it (2.9).                                                                                                                                                                                                         |
| `routes/snoozeAi.ts`, `db/wake.ts`, `db/history.ts`, `db/replay.ts` | No test file of their own; covered indirectly by `snooze-activity`, `insights`, `rpg` and `habits` tests. Acceptable, but `history.ts` is shared arithmetic (quantiles, DST day counting, undo and bulk indexes) that would be cheap to pin directly.                                       |
| `youtube/client.ts`                                                 | No test for a request that never answers (2.9).                                                                                                                                                                                                                                             |

Positive notes: `hardening.test.ts`, `insights-boundary.test.ts` and `rpg-boundary.test.ts` are architecture tests
that check what the read-only layers may import and write; `sync/resilience.test.ts` and `reply/poster.test.ts`
cover the awkward failure paths well.

---

## 7. Top 10 to do first

1. **Make the LLM cap fail safe for unknown models** (2.1). Bug, S.
2. **Delimit and escape item titles in the assistant prompt; restrict standing notes from that path** (1.1), and make
   `createLlmClient` take a `fetchImpl` so it can be tested. Risk, S.
3. **Confirm and close the loopback-`Host` path around the Tailscale user check** (1.2). Risk, S.
4. **Replace the hard-coded owner in prompts and the `'matt'` enum with an owner profile and `me`** (3.1) before the
   repository is public. Cleanup, L.
5. **Add CI (typecheck, lint, vitest, Playwright) and coverage; install typescript-eslint or delete the dead
   `eslint-disable` comments** (3.3). Cleanup, M.
6. **One spend ledger and one `spentTodayUsd`, including the assistant, not erasable by "Reset usage data"** (2.2).
   Risk, M.
7. **Fix the silent logger in the snooze route and add rejection safety nets to the background loops** (2.3, 2.7).
   Bug/risk, S.
8. **Delete `db/tiers-lite.ts` in favour of one tier table** (2.4) and **remove the duplicate ownership recompute**
   (2.8). Bug/cleanup, S.
9. **GitHub poller: no overlap when resuming a truncated window, and a tri-state for the latest commenter**
   (2.5, 2.6). Risk, S.
10. **One Anthropic transport** (4.1), then start splitting `db/repo.ts` with the snooze logic first (5.2, 4.4).
    Cleanup, M then L.

After those: remove the `YOUTUBEY_*` legacy paths and document or centralise the remaining environment variables
(3.2), make `AppDeps` members required with a test-deps helper (5.4), and put a clock on `AppDeps` (6.1).
