# Web review (web/ and shared/)

Read-only housekeeping review of the Svelte 5 client, done by reading the code against README.md and docs/.
`svelte-check` reports 0 errors and 0 warnings; `vitest run` passes (97 files, 1240 tests). No e2e was run.

Each finding is tagged **severity** (bug / risk / cleanup / nit) and **effort** (S / M / L, sized by what it touches).
Paths are relative to the repo root; line numbers are as of commit `770cf26`.

## Verdict

The client is in good shape for something this feature-dense: types are tight (no `any`, three narrow
`as unknown as` casts), HTML from outside goes through one DOMPurify gate with small allow-lists, the pure logic in
`web/src/lib` is mostly unit-tested, listeners and timers are cleaned up carefully, and phone and desktop share
components through a `tile` prop instead of forking them. The weak spots are where several mechanisms meet. The
inbox store, the URL and the event stream each hold part of "what the list shows", and the seams between them
produce the real bugs below: an Undo that undoes the wrong thing, server changes that are dropped when the cursor is
not on the first row, a thread pane that blanks on every live update, and filters defined in five places that
disagree. The keymap is a strong idea (buttons and keys share one binding) but it lets `Ctrl/Cmd+Z` through into
text fields, and hard-coded key hints have drifted from it. For open-sourcing, the main structural debts are five
hand-rolled dialogs, three copies of the open-item header, a 980-line Settings view and a 700-line inbox store that
does eight jobs. None of it needs a rewrite; most of the bugs are small fixes with a unit test each.

## 1. Bugs and behavioural risks

### 1.1 Ctrl/Cmd+Z in a text field undoes the last triage — bug, S

- `web/src/lib/keys/keymap.svelte.ts:170-173`: a key pressed in an editable element is passed to bindings whenever a
  command modifier is held.
- `web/src/lib/keys/bindings.ts:281-287`: `triage.undo` is bound to `z` and `$mod+z` in the `list` scope.

So in the search box (and the add-source and own-channel fields on the empty inbox, which are also in `list`
scope), `Ctrl+Z` does not undo typing: it calls `preventDefault` and reverts the last triage or snooze. The composer
and the menus are safe only because their scopes are exclusive.

Fix: in `handle`, when the target is editable, only let through bindings that opt in (`palette.open`,
`composer.send`, `composer.copy`), or drop `$mod+z` when `isEditable`. Touches `keymap.svelte.ts` and one new case
in `keymap.test.ts`.

### 1.2 "Undo" on a toast undoes the newest action, not that toast's — bug, S

- `web/src/lib/stores/inbox.svelte.ts:571-574`: every success toast gets `run: () => void this.undo()`.
- `web/src/lib/stores/inbox.svelte.ts:592-594`: `undo()` pops the top of the stack.
- Same in `web/src/lib/reply.ts:67`.

Toasts live 6 s and four are shown at once (`toasts.svelte.ts:22`). Mark A done, mark B done, click Undo on A's
toast: B comes back. The server already undoes by action id (`api.undo(actionId)`), so the fix is local:
`undo(entry?)` removes that specific entry from the stack. Add a store test for "undo an older entry".

### 1.3 A failed request plus a quick `z` leaves the list in the state the server rejected — bug, S

`inbox.svelte.ts:542-616`. If `z` is pressed while the original request is in flight and that request then fails,
`#commit`'s catch rolls the items back to "before" (577-586), and then `undo()`'s catch, which awaited the same
rejected promise, re-applies "after" and restores its own count snapshot, which was taken after the optimistic change
(599, 610-613). The item ends up shown as done (or gone) with shifted counts although nothing was saved, with two
error toasts. It heals on the next refresh. Fix: in `undo()`, when `entry.actionId` rejects, do nothing (the commit
path already rolled back). One store test.

### 1.4 Server-side changes are ignored unless the cursor is on the first row — risk, M

`inbox.svelte.ts:668-683`. On `inbox.changed`, the list is refreshed only when `selectedIndex <= 0` and the composer
is not focused. Otherwise only _added_ ids are remembered (the "N new" pill); _changed_ ids in the loaded list are
dropped. An item marked done on the phone, auto-cleared by your own reply on YouTube, or closed upstream stays in the
desktop list as an inbox row until some later event arrives while the cursor happens to be on row 0. Acting on it
then sends a triage for something already finished. The Done and Snoozed views never note additions at all (line 673).

Fix: for touched ids, patch or remove those rows in place (the event carries the ids; fetch just those, or add the
changed items to the event), keeping cursor and scroll; keep the pill for additions. Touches the store, possibly the
`inbox.changed` payload in `shared/types.ts`, and the store tests.

### 1.5 The open thread blanks and re-scrolls on every live update — bug, S

- `inbox.svelte.ts:671` calls `thread.invalidate()` on every `inbox.changed`, which only clears the cache
  (`thread.svelte.ts:72-74`).
- `web/src/views/InboxView.svelte:105-116` re-runs whenever `inbox.items` or the selected item's object identity
  changes (any `refreshTop`, a suggestion arriving, the first keystroke of a draft via `setHasDraft`), and calls
  `thread.show(id)`.
- `thread.svelte.ts:58-59`: on a cache miss `show` sets `current = null; loading = true`, even when `id` is the
  thread already on screen.
- `web/src/components/ThreadView.svelte:44-54` then scrolls back to the focused comment when the refetch lands.

Net effect: while reading a long YouTube thread, any new comment anywhere replaces the conversation with the
skeleton and resets the scroll position. Fix in `thread.show`: when `id === current?.threadId`, keep `current` while
refetching and swap when it arrives; have `invalidate()` mark entries stale instead of deleting them. `#fetch` also
dedupes by id but ignores `focus` (line 25), and a fetch in flight during `invalidate()` repopulates the cache with
the old data. `thread.svelte.ts` has no unit tests; this is a good reason to add them.

### 1.6 The page reloads itself on return to the tab, against the stated rule — risk, S

- `web/src/lib/resync.svelte.ts:22-33, 46`: `resync.run()` calls `location.reload()` when the server has a newer
  build. It runs on tab return after 5 s, on `online`, on `pageshow`, on `Shift+R`, on the Refresh button and on
  pull-to-refresh.
- `web/src/lib/stores/update.svelte.ts:27-31` says a reload "happens on a click and never by itself" because it
  discards half-typed text. `README.md:196-197` says the banner "never reloads by itself"; `README.md:372-373` says
  a returning tab "reloads itself".

Both mechanisms exist and contradict each other. Come back to the tab after a deploy with a snooze reason, an
assistant message or a note half-typed and it is gone. Pick one: either `resync.run()` only raises the banner
(`update.noteServerBuild`), or it skips the reload while a text field has content or a dialog is open. Then make the
two README paragraphs agree. `e2e/update.spec.ts` covers the banner; nothing covers the reload-on-return path.

### 1.7 The search box can swallow a space — bug, S

`InboxView.svelte:136-138` copies the URL's `q` back into `searchText` whenever `q` changes, and
`InboxView.svelte:159-162` writes `searchText.trim()` to the URL after 200 ms. Type "foo " quickly and pause: the
debounce writes `q=foo`, the effect sets the box to "foo", and the next word produces "foobar". Fix: only adopt `q`
when it differs from `searchText.trim()` (or only on navigation, not on our own write). No e2e spec types into the
search box at all (see 4.3).

### 1.8 Filters are defined in five places that disagree — bug S, cleanup M

The filter set is spelled out in `InboxFilters` (`inbox.svelte.ts:23-33`), the `same` check and `filterKeys` in
`configure` (205-226), the deriveds in `InboxView.svelte:55-87`, `filtered` (`InboxView.svelte:191`), and two
"clear" lists (`InboxView.svelte:394-396`, `bindings.ts:351-359`). Consequences today:

- `filtered` omits `feed`, `repo`, `kind` and `who`. With "Bots" selected and nothing matching, the inbox says "All
  caught up" with a Sync button instead of "Nothing matches".
- The "Clear filters" button shows the `g c` hint, but the binding's `when` ignores `sug`, so with only a suggestion
  filter `g c` does nothing; and neither clear path removes `feed`, `repo`, `kind` or `who`.
- `AUDIENCES` in the view (line 66) lacks `people`, which the type and server accept.

Fix: one `web/src/lib/filters.ts` with `FILTER_QUERY_KEYS`, `filtersFromQuery(query)`, `hasFilters(filters)` and
`clearedQuery()`, unit-tested, used by the view, the store and the binding.

### 1.9 The mute menu can leave an invisible modal scope — risk, S

`web/src/components/MuteMenu.svelte:89-115` pushes the exclusive `modal` scope while `ui.muteFor` is set, but the
dialog renders only while the item is still in the list (line 118). If a live refresh removes the item while the
menu is open, the dialog disappears and the keyboard stays captured (only Esc, Enter, j/k and 1-5 do anything)
until Esc is pressed. Close the menu when `item` becomes undefined, or key the effect on `item`.

### 1.10 Deep links by `?c=` only work within the first page — risk, M

`inbox.configure`/`load` select `c` only if it is among the first 100 rows (`inbox.svelte.ts:216-218, 246-247`);
otherwise the first row is selected and the URL is rewritten 300 ms later (`InboxView.svelte:122-130`). Affected:
Insights item links into All (`InsightsPanel.svelte:80-81`), push notification taps (`server/push/notifier.ts`
builds `/inbox?c=`) when the order is "oldest" or the list was already loaded with the cursor away from the top (the
new item is only "pending" then), and on a phone the tap lands on the list because `ui.pane` is not set. Fix needs
either a `focus` parameter on `/api/inbox` or a single-item fetch that is spliced in; then open the thread pane.

### 1.11 Wrong or stale key hints — bug, S

- `web/src/components/TodoThread.svelte:78`: "`s` snoozes it". Snooze is `b`; `S` is deep sync.
- `TodoThread.svelte:47`: `added {relativeTime(...)} ago` renders "added now ago" and "added Mar 3 ago"; use `ago()`.
- `README.md:185` and `README.md:203` say `5` picks a time and `6` is "Until activity"; since "In 1 hour" and "This
  evening" were added they are `6` and `7` (`SnoozeMenu.svelte:27-28, 147`). The e2e title at
  `e2e/snooze-activity.spec.ts` ("a reason key and 6") presses `7`.

The cause is 18 `<Kbd label="…">` and 10 raw `<kbd>` literals, while `Kbd` already accepts `id=` to read the key
from the keymap (`Kbd.svelte:5-6`) and nobody uses it. Replace literals for registered bindings with `<Kbd id>`;
the snooze-menu digits should come from the same constants that bind them.

### 1.12 View counts are inflated on every resync — bug, S

`web/src/lib/stores/app.svelte.ts:31` counts `view.<route>` inside `boot()`. `boot()` also runs on every resync
(`resync.svelte.ts:48`), on stream reconnect and from the watchdog (`sse.ts:113-119, 126-131`). `usage.start` is
idempotent but `count` is not, so each return to the tab adds a view. Count once, guarded by a flag, or move it next
to `usage.start` behind the same "first time" check. The Usage panel's "views" numbers are wrong until then.

### 1.13 Habit events and discussion fetches fire on object identity, not on the item — nit, S

`ThreadView.svelte:26-31`, `GithubThread.svelte:28-33` and `TodoThread.svelte:22-27` call `decisions.open(...)` in
an effect that reads `item.comment.id` directly. The compiled effect depends on the `item` prop, so every list
refresh closes and reopens the "open" record: extra `open` events and split dwell times in the habit data. The same
applies to `GithubDiscussion`'s `itemId={it.id}` (refetches on every refresh; cheap because the server caches for
3 minutes). Read the id through a `$derived` first, as `Composer.svelte:14` already does.

### 1.14 Error states that are missing or misleading — risk, S each

- `web/src/views/StatsView.svelte:20-28, 67-68`: a failed load toasts, then shows "Nothing tracked yet".
- `web/src/components/InsightsPanel.svelte:59-74, 129`: if a range switch fails while older data is shown, the new
  range button is highlighted over the old range's numbers and nothing says so (`failed` is only rendered when there
  is no data).
- `web/src/components/UsagePanel.svelte:12-22`: no stale-response guard; 7 → 30 → 7 can show the 30-day answer.
- `web/src/lib/stores/drafts.svelte.ts:38-50`: a failed draft save is swallowed; the text then exists only in
  memory and a reload loses it without warning.
- `web/src/lib/sse.ts:120-122`: a dead event stream sets a private flag only. There is no "disconnected" indicator;
  the first sign is a failed action. `SyncIndicator` is the natural place.

### 1.15 Accessibility — risk, M as a cluster

- **Low-contrast text.** `--text-faint` is `#a1a1aa` on white (about 2.6:1) and `#6b6b75` on `#0b0b0d` (about 3.7:1)
  (`web/src/styles/tokens.css:32, 80`), and `.faint` is used 76 times for real content: timestamps, snooze times,
  counts, hints. Darken/lighten the token to reach 4.5:1; one-line change with wide visual reach.
- **Dialogs.** `SnoozeMenu`, `MuteMenu`, `CommandPalette`, `HelpOverlay` and `Assistant` all claim
  `aria-modal="true"` but none traps focus or restores it on close, the page behind is not inert, and
  `HelpOverlay.svelte:58-66` never moves focus into itself. In the snooze menu `Tab` is rebound to jump to the "why"
  field (`SnoozeMenu.svelte:146`), so the option buttons cannot be tabbed to and `Shift+Tab` leaves the dialog.
- **The list.** `VirtualList.svelte:163-173` is a `listbox` (labelled "Comments" even for GitHub and todos) whose
  `option` rows (`InboxRow.svelte:121-141`) contain a checkbox and up to four buttons, which a listbox option may
  not, and the Snoozed section headings sit inside it as plain divs. Selection moves by a global key handler with no
  focus or `aria-activedescendant`, so assistive tech is never told which row is current. A `list` of rows with a
  roving `tabindex` (or `grid`) would be valid and would also make the row buttons reachable.
- `InboxView.svelte:461-470`: the resizer is `role="separator"` with no `tabindex`, value or keys, and never ends a
  drag on `pointercancel`.
- `Toasts.svelte:6-8`: `role="status"` items inside an `aria-live` container (double announcement), and errors are
  not `role="alert"`.
- `CommandPalette.svelte:141-153`: the combobox has no `aria-activedescendant`.

### 1.16 XSS / unsafe HTML — no finding

`{@html}` appears three times (`CommentCard.svelte:70`, `GithubThread.svelte:96`, `GithubDiscussion.svelte:114`),
always through `web/src/lib/sanitize.ts`: tag allow-list, `href` only, `https?:` only, images turned into links.
Links opened with `window.open` use `noopener`. Two small hardening points: `href={it.url ?? '#'}`
(`GithubThread.svelte:51, 55`) and `comment.permalink` trust the server to send http(s) URLs, so a shared
`safeHref()` would make that explicit; and `sanitize.ts` has `markdown.test.ts` but no test for
`sanitizeCommentHtml`.

## 2. Duplication

### 2.1 Five hand-rolled dialogs — cleanup, M

`SnoozeMenu`, `MuteMenu`, `CommandPalette`, `HelpOverlay`, `Assistant` each repeat: a `.scrim` (the same CSS block
five times), a `role="dialog"` panel with a `svelte-ignore`, `stopPropagation` on the panel, an effect that pushes a
scope, registers Escape and focuses something after `tick()`, and a phone bottom-sheet media query. SnoozeMenu and
MuteMenu share 42 of MuteMenu's 50 distinct CSS lines. One `Modal.svelte` (props: `open`, `label`, `onclose`,
`scope`, `initialFocus`; a `children` snippet) would hold the scrim, focus trap, focus restore and Escape, and fix
the dialog items in 1.15 and the stale-scope bug in 1.9 in one place. A second small `OptionList` would cover the
`active` index, hover, j/k, digits and Enter that SnoozeMenu and MuteMenu both implement.

### 2.2 Three copies of the open-item pane — cleanup, M

`ThreadView`, `GithubThread` and `TodoThread` repeat the Back button, title block, `SnoozeNote`, the state/snooze
tag row, `ItemActions`, the suggestion chip, the `headerWidth`/`inline` logic (with thresholds 1500, 1700 and 1500),
the `usage.count` + `decisions.open` pair, and their CSS (TodoThread shares 38 of its 41 distinct CSS lines with
GithubThread; ThreadView 30 of 73). Extract `ItemPane.svelte` with `title`, `meta` and `body` snippets. The "back
from snooze" test (`!item.snoozedUntil && state === 'inbox' && recentlyWoken(...)`) is written four times
(`InboxRow.svelte:113` and each pane); make it `isBackFromSnooze(item, now)` in `lib/snooze.ts`.

### 2.3 Settings: three identical secret fields, three "add my channel" forms — cleanup, M

`web/src/views/SettingsView.svelte:54-147` has the same input/Test/Save/Remove flow with `busy` and `result` state
for the YouTube key, the Anthropic key and the GitHub token; a `SecretField.svelte` removes about 100 lines of
script and three markup blocks. Adding an own channel is implemented in `SettingsView.svelte:159-170`,
`AddSourceForm.svelte:36-47` and `OwnChannelForm.svelte`; Settings can use `OwnChannelForm`.

### 2.4 Repeated fetch-with-state code — cleanup, S/M

"Fetch when a dependency changes, ignore stale answers, track loading and error" is written by hand in
`GithubDiscussion.svelte:29-49` (`live`), `SourcesView.svelte:27-39` (`cancelled`), `InsightsPanel.svelte:59-74`
(compare range), `UsagePanel.svelte:12-22` (no guard) and `StatsView.svelte:39-41` (no guard, an effect used as
`onMount`). A small `resource(() => deps, fetcher)` helper in `lib/` returning `{ data, error, loading }` would
make all five the same and fix 1.14's stale cases. Likewise `e instanceof Error ? e.message : '…'` appears 44 times;
an `errorMessage(e, fallback)` helper is trivial.

### 2.5 Smaller repeats — nit, S each

- Sidebar links: the `preventDefault(); router.navigate(...); ui.pane = 'list'` handler is written eight times
  (`Sidebar.svelte:182-345`). A `NavLink` component would also let Ctrl/Cmd-click open a new tab, which
  `preventDefault` blocks now.
- CSS: `.grow { flex: 1 }` is declared in 16 components; `.scrim`, `.seg`, `.sr`, `.tablewrap` and the pill-shaped
  select are each declared in several. Move them to `styles/base.css`. The `(max-width: 899px)` breakpoint appears 29
  times in CSS and twice in TS (`phone.svelte.ts`, `usage.ts:174`); CSS cannot share a constant, but `usage.ts`
  should read `phone.value`.
- localStorage: five separate try/catch readers and writers (`ui.svelte.ts:4-18`, `inbox.svelte.ts:114-123`,
  `Sidebar.svelte:22-39`, `lib/insights.ts`, `theme.svelte.ts`) with three key styles (`yt-theme`,
  `nudge-inbox-order`, `nudge.insights.range`). One `lib/storage.ts`; rename the `yt-` keys with a one-time
  migration before the names become public.

## 3. Abstractions

### 3.1 Largest files

| Lines | File                                      | Note                                                          |
| ----: | ----------------------------------------- | ------------------------------------------------------------- |
|   980 | `web/src/views/SettingsView.svelte`       | 11 sections in one component; split per section (see 2.3)     |
|   979 | `web/src/components/InsightsPanel.svelte` | about 30 cards inline; split per group (Rhythm, Responses, …) |
|   843 | `web/src/views/InboxView.svelte`          | 350 lines are CSS; header/filters/bulk bar are separable      |
|   704 | `web/src/lib/stores/inbox.svelte.ts`      | see 3.2                                                       |
|   657 | `web/src/components/Sidebar.svelte`       | 300 lines CSS; source/feed tree is separable                  |
|   619 | `web/src/components/InboxRow.svelte`      | 320 lines CSS; logic is small                                 |
|   615 | `shared/types.ts`                         | fine as one file, but see 3.5                                 |
|   461 | `web/src/components/SnoozeMenu.svelte`    | shrinks with 2.1                                              |
|   393 | `web/src/lib/keys/bindings.ts`            | fine; untested (see 4.2)                                      |

### 3.2 The inbox store does eight jobs — cleanup, L

`inbox.svelte.ts` owns paging and merge, the cursor, multi-selection, optimistic triage and snooze, the undo stack,
sidebar counts, the pending pill, habit logging (`#decide`), toast wording and a localStorage preference. It also
reaches into `thread`, `settings`, `toasts`, `usage` and `decisions`, while `ui`, `drafts`, `feeds`, `assistant` and
`sse` reach into it, and `Composer` sets a plain `inbox.composing` flag on it (`Composer.svelte:58, 62, 122`). The
bugs in 1.2-1.5 all live in the seams. Suggested split, in order of value:

1. Pure list functions in `lib/inboxList.ts` (`mergeFirstPage`, `applyChanges`, `pickCursorAfterRemoval`,
   `compareItems`, `viewIncludes`, `shiftCounts`), each unit-tested without a store.
2. An `UndoStack` class (entries addressable by identity, which fixes 1.2 and 1.3).
3. Selection (cursor plus multi-select) as its own small store.

The existing 500-line store test makes this safer than it sounds.

### 3.3 Keymap and scopes — cleanup, S/M

The design is sound and worth keeping: one registry, `invoke(id)` so a button cannot drift from its key, `when`
guards, exclusive scopes. Inconsistencies:

- `palette`, `help` and `modal` are three scopes with identical behaviour; `modal` alone would do.
- `Binding.global` (fires through exclusive scopes) and `scope: 'global'` (base layer) are different things with
  the same name; only `palette.open` uses the flag. Rename it `always` or similar.
- Editable targets: see 1.1. The rule "modifier keys pass through inputs" should be opt-in per binding.
- The composer pushes its scope on focus and pops on blur (`Composer.svelte:56-66`), every other scope on mount.
- Menu bindings are registered inside effects with `group: 'App'` and a shared description, so the snooze menu's
  keys (digits, `w m f l`, `u`, Tab) never appear in the `?` overlay.
- `ActionButton` does not reflect a binding's `when`: a button whose binding is unavailable still looks enabled and
  does nothing (`keymap.svelte.ts:289-294`). `disabled` could default to `!available(id)`.
- `bindings.ts:15-16`: two doc comments stacked on `isYoutube`; the first belongs to `appBindings`.
- `open.video` (`bindings.ts:304-318`) and `sync.deep` (139-150) assume a YouTube video; on a todo or (for `S`) a
  GitHub item they open a YouTube URL built from a stand-in id or start a sync for it. Gate with `isYoutube`.

### 3.4 URL and selection are bound in both directions — risk, S

`InboxView.svelte:74-87` pushes `?c=` into the store and `122-130` writes the selection back to `?c=` on a 300 ms
timer, and the first effect re-runs because of that write. It converges today, but it is the reason for comments
like the one at `Sidebar.svelte:101-102`. Treat `c` as read-once on navigation (popstate or a programmatic
`navigate`) and write-only otherwise.

### 3.5 API typing shared with the server — cleanup, M

`shared/types.ts` and `shared/api.ts` are imported by both sides, which is good. Gaps:

- `web/src/lib/api.ts` declares nine response shapes inline (`{ ok; message }` three times at 169-188, `nudgeDraft`,
  `authStart`, `feeds`, `addMute`, `pushTest`), so the server cannot be checked against them. Move them to
  `shared/api.ts`.
- `request()` returns `data as R` unchecked and returns `undefined as R` on 204, so a route that changes shape fails
  far from the cause. A route table in `shared/api.ts` (path, method, request, response) used by both sides would
  give compile-time agreement without runtime cost.
- `NoteDTO.suggestion` is loose enough that `SettingsView.svelte:34-39` needs four `as` casts; type it as the
  suggestion fields it stores.
- 89 imports climb to `../../../shared/…`. A `$shared` alias in `web/tsconfig.json` and `vite.config.ts` removes
  the noise.

### 3.6 Module singletons with side effects at import — nit, S

`router` adds a `popstate` listener in its constructor, `phone` a media-query listener, `sync` a 30 s interval
(`sync.svelte.ts:20`), none removable. Fine for the app; it is why tests need `reset()` helpers on some stores and
not others. An `init()` called from `App.svelte` (as `theme.init()` and `keymap.attach()` already are) would be
consistent.

## 4. Testability

### 4.1 Logic in components that should be pure functions in lib/ — cleanup, S each

| Where                                      | What                                                          | Suggested home                          |
| ------------------------------------------ | ------------------------------------------------------------- | --------------------------------------- |
| `InboxView.svelte:55-87, 191`              | query → filters, "is filtered"                                | `lib/filters.ts` (see 1.8)              |
| `SnoozeMenu.svelte:27-28, 81-101`          | row indices, skipping the hidden evening slot, digit → choice | `lib/snooze.ts`                         |
| `MuteMenu.svelte:21-74`                    | the mute options for an item                                  | `lib/github.ts` `muteOptions(item)`     |
| `Sidebar.svelte:41-51`                     | repos under an owner, sorted                                  | `lib/github.ts`                         |
| `SettingsView.svelte:29-50`                | `noteContext`                                                 | `lib/notes.ts`                          |
| `InboxRow.svelte:97-118`                   | the row's derived flags and labels                            | `lib/itemState.ts` `rowView(item, now)` |
| `InsightsPanel.svelte:173-198` and similar | per-hour and per-weekday sums in the template                 | `lib/insights.ts`                       |
| `inbox.svelte.ts:405-421, 498-504`         | toast wording for triage and snooze                           | `lib/itemState.ts`                      |

### 4.2 Untested lib code — cleanup, M

No unit tests for: `stores/thread` (cache, staleness: 1.5), `stores/drafts` (debounce, hold/restore/discard around
a send), `stores/toasts`, `stores/settings` (optimistic save and rollback), `stores/sources`, `stores/notes`,
`stores/assistant` (outcome and undo mapping), `stores/rpg` (debounce, generation guard, visible-tab claim),
`stores/push`, `stores/theme`, `stores/ui`, `fuzzy.ts`, `tip.svelte.ts`, `sanitizeCommentHtml`, and `bindings.ts`
(a cheap table test would catch duplicate keys within a scope, ids missing from `BINDING_ACTIONS`, and `when`
guards). `thread` and `drafts` first: they guard user-visible state and text. Only one component has a unit test
(`InsightsPanel.test.ts`), although `@testing-library/svelte` is installed.

### 4.3 e2e gaps by feature — risk, M

Read from the spec titles and greps of `e2e/`; nothing was run.

| Feature                                      | Covered                                          | Missing                                                                                         |
| -------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Search                                       | phone magnifier toggle only                      | typing, debounce, Escape, "Nothing matches", `g c`, `/` focus (1.7, 1.8 would have been caught) |
| YouTube sources                              | own-channel add                                  | add playlist/video, source detail, tier override, remove and purge, enable/disable              |
| Composer drafts                              | post and failed post in API mode                 | draft saved and restored on reselect, "Draft" badge, Escape cancel, hand-off copy failure       |
| Undo                                         | single `z`                                       | Undo from an older toast, `z` during a slow request (1.2, 1.3)                                  |
| Multi-select                                 | `x`, `* a`, long-press, select-all-matching      | `J`/`K` extension, selection cleared on filter change                                           |
| Live updates                                 | new item at top / pill                           | a change to a loaded row while scrolled (1.4), thread pane during an update (1.5)               |
| Snooze menu                                  | presets, why, buckets, until activity            | custom date-time confirm, past-time error                                                       |
| Reload policy                                | banner                                           | reload on tab return (1.6)                                                                      |
| Deep links                                   | Insights link with small data                    | `?c=` beyond the first page, notification tap (1.10)                                            |
| Keys                                         | chords, palette, help, Enter on a focused button | `Ctrl+Z` in an input (1.1), `v`/`V`, `S`, `g v`, `t`, `[`                                       |
| Error states                                 | GitHub discussion failure                        | boot failure and Retry, inbox load failure, thread load failure, quota banner                   |
| Onboarding                                   | none (demo mode never needs a key)               | the no-key screen                                                                               |
| Accessibility                                | a few `aria-` assertions                         | focus after dialogs close, an axe pass per view                                                 |
| Delete reply, list resizer, sidebar collapse | none                                             | all                                                                                             |

## 5. Simplifications, dead code, naming, performance

- **Dead code** (nit, S): `ActionButton`'s `pressed` prop and its `aria-haspopup` branch are never passed
  (`ActionButton.svelte:27, 45-46, 71-72`); `HelpOverlay.svelte:45-47` is an empty `if`; `hotkeyLabel`
  (`keymap.svelte.ts:265-268`), `BUCKET_LABEL`/`PROVIDER_LABEL` exports in `lib/insights.ts` and the `entryScript`
  re-export (`resync.svelte.ts:15`) have no importers; `monthLabel` and `busiestWindow` are used only by tests.
  `CommandPalette.svelte:109` defers twice (`queueMicrotask` then `setTimeout`); one is enough. No unused components.
- **Debug hook in production** (nit, S): `VirtualList.svelte:124-143` installs `window.__nudgeDebugList` in every
  build. Gate it on `import.meta.env.DEV` or a query flag before publishing.
- **Bundle** (cleanup, S): one 444 KB JS chunk and 84 KB CSS, with no code splitting. Stats (Insights, charts,
  Hall of Heroes, `RpgArt`), Settings and `marked` are needed on a minority of visits; `await import()` for
  `StatsView` and `SettingsView` in `App.svelte` is a few lines. Low priority for a local app, visible on a phone
  over Tailscale.
- **Hot spots** (nit, S): `inbox.svelte.ts:672, 680` is O(changed × loaded) with nested `some`; use a `Set` of
  loaded ids (matters after "Select all 5,000"). `selectedIndex` is a `findIndex` per selection change and
  `InboxView.svelte:49-53` adds a second one in the Snoozed view; an id → index map derived once from `items`
  serves both. Every tooltip attachment re-runs when any binding is registered because `tip()` reads the registry
  (`tip.svelte.ts:54`), so opening a menu re-attaches seven listeners on every visible action button; read the
  hotkey lazily in `show` instead. `VirtualList` itself is fine.
- **Naming** (nit, S): the `comment`/`video` stand-ins on `InboxItem` for GitHub items and todos
  (`shared/types.ts:155-162`) leak everywhere (`inbox.selected.video.id`, "Couldn't load comments",
  `aria-label="Comments"`, `pluralize(count, 'comment')` in the snooze menu for any provider). A rename to
  `entry`/`container` is L and not urgent, but user-facing strings should say "items" when feeds exist, as
  `InboxView.svelte:203` already does. `InboxView` is both a view component and a type in `shared/types.ts`
  (imported side by side in `InboxView.svelte`).
- **Tick counters as events** (nit): `composerFocusTick`, `searchFocusTick`, `addSourceFocusTick`, `threadScroll`,
  `assistant.focusTick`, `rpg.sparkle`. It works, but six copies of "bump a number, compare in an effect" would read
  better as one tiny `signal()` helper.

## Top 10 to do first

1. **Stop `Ctrl/Cmd+Z` in text fields from undoing triage** (1.1) — bug, S.
2. **Make a toast's Undo undo that toast's action; ignore undo of a failed request** (1.2, 1.3) — bug, S.
3. **Apply server changes to loaded rows wherever the cursor is** (1.4) — risk, M.
4. **Keep the open thread on screen across live updates** (1.5), with first unit tests for `thread` — bug, S.
5. **Decide the reload policy and make code and README agree** (1.6) — risk, S.
6. **One filter definition in `lib/filters.ts`**, fixing "All caught up" under filters and `g c` (1.8), and the
   search-space bug next to it (1.7) — bug, S/M.
7. **Fix the wrong hints and take key labels from the keymap** (1.11) — bug, S.
8. **Count views once, and stop effects firing on object identity** (1.12, 1.13) — bug, S.
9. **One `Modal` component** with focus trap/restore, which also closes 1.9 and most dialog items in 1.15; raise
   `--text-faint` contrast in the same pass (2.1, 1.15) — cleanup, M.
10. **e2e for search, sources management and drafts**, the three everyday features with no coverage (4.3) — risk, M.

After those: `ItemPane` (2.2), splitting Settings (2.3), the inbox store split (3.2), shared response types (3.5).
