# Keys

Nudge is built to be driven from the keyboard: every triage action has a key, and also a button whose tooltip names
it. This page has the main keys (press `?` in the app for the full list), what "no action needed" and the snooze keys
do, snoozing until someone acts, and selecting several items at once. Back to the [README](../README.md).

## The keys

| Key                                      | Action                                                          | Key         | Action                              |
| ---------------------------------------- | --------------------------------------------------------------- | ----------- | ----------------------------------- |
| `j` / `k`                                | next / previous                                                 | `e` / `d`   | done                                |
| `m`                                      | mark replied (no reply)                                         | `u`         | back to list (from the thread)      |
| `z`                                      | undo                                                            | `r`         | reply                               |
| `x`, `J`/`K`                             | multi-select                                                    | `* a` `* n` | select all / none                   |
| `Shift+U`                                | move back to inbox                                              | `v` / `V`   | open comment / video on YouTube     |
| `Shift+N` / `S`                          | sync now / deep-sync video                                      | `/`         | search                              |
| `b`                                      | snooze… (`1`-`5` presets, `6` a time, `7` until activity)       | `Ctrl+K`    | command palette                     |
| `g i`, `g d`, `g a`, `g s`, `g t`, `g ,` | go to Inbox, Done, All, Sources, Stats, Settings                | `c`         | tell Nudge… (todos, voice commands) |
| `g z`                                    | go to Snoozed                                                   |             |                                     |
| `Shift+O`                                | cycle sort order                                                |             |                                     |
| `n`                                      | no action needed (done, recorded as dismissed)                  |             |                                     |
| `B`                                      | snooze again, until activity (an item that came back with none) |             |                                     |

**No action needed** (`n`) is Done for "there is nothing for me here": the item leaves the inbox and returns on new
activity exactly as Done does, but it is recorded (and shown in All as "Dismissed") apart from the things you did, so
the habits report can tell whether a "skip" suggestion was right. The open item's toolbar puts the decisions (Done, No
action, Replied, Snooze) first and the tools (Mute, Undo, Open) in a small icon cluster; the button the current
suggestion points at wears a faint ring. When a new version has been deployed, a quiet "New version available ·
Reload" bar appears; it never reloads by itself.

Snoozing hides a comment until the time you pick; it returns to the top of the Inbox (a "back from snooze" marker
shows for a day), and `z` undoes it. In the Snoozed view `Shift+U` unsnoozes.

## Snooze until activity

Usually you are waiting for something to happen, not for a date. In the snooze menu (`b`), **Until activity** (`7`)
parks the item until someone other than you acts on it, with a fallback date so it can never be forgotten. Pick why it
is parked with one key or tap, optionally with the words you already type in the why field: `w` waiting on them, `m`
waiting on merge / CI, `f` in flight (you are on it), `l` lower priority. The fallback comes from the bucket (waiting
on them 7 days, waiting on merge 3, in flight 7, lower priority 30; each is a number in **Settings > Preferences >
Snoozing until activity**, 1 to 365), and `u` ("also wake on activity") turns any time you pick, a preset or a date,
into the fallback instead. A bucket on its own with a time is an ordinary timed snooze with a reason. The fast path is
unchanged: `b`, a time key, done.

- **What wakes it.** GitHub: a new comment from someone other than your own accounts (Settings > You > My GitHub
  accounts), or the item being closed or merged; your own comments never do. YouTube: a new reply in the thread from
  anyone but your channels. It returns to the top of the Inbox marked "back: new activity". (GitHub reviews and CI
  status are not looked at: the poller only reads comment counts and state.) Nothing in a request path calls GitHub:
  the poll that notices the growth asks who wrote the newest comment, with the same capped lookups as Done items
  coming back.
- **The audit line.** If the fallback date arrives with nothing having happened, the item comes back as "Still waiting
  on them (7d, no activity)", on the row and in the open item, with `B` snooze again (same bucket and words), `d` done,
  `n` no action needed and `v` open on GitHub. For GitHub items that were waiting on someone, **Draft a nudge** asks the
  small model (your Anthropic key) for a short follow-up comment to copy; the thread text goes to it as data, and
  nothing is ever posted. Without a key the button is not shown.
- **Free-text reasons.** A reason typed in the field (or said to Tell Nudge, which also understands "snooze until they
  reply") with no bucket is filed afterwards by the small model, never holding up the snooze; the event records that the
  bucket was assigned automatically. No key, no call. These calls and the nudge drafts draw on the same daily cost cap as
  suggestions and the assistant.
- **The Snoozed view** is in sections by bucket ("Waiting on them (4)", oldest age on the right) and each row says how
  long ago it was parked.
- **Learning data.** Every snooze event carries its bucket and whether it waited on activity; the wake event says why it
  ended (`activity`, `fallback`, or `manual` for an unsnooze by hand). `npm run report:habits` shows snoozes by bucket,
  how those waits ended, the median time to wake, and what you did next after a fallback wake (done, no action needed,
  snoozed again). The suggestion prompt also sees the bucket and whether the wait ran out with no activity.

## More keys, and selecting several

Also: `t` cycles the theme, `[` toggles the sidebar, `Shift+R` refreshes, `.` shows newly arrived items, `Shift+M`
mutes (GitHub), `g v` filters to the current video and `g c` clears filters.

Selecting several: on a desktop, hover a row and click the tick on its avatar (or `x`); on a phone, long-press a row,
then tap others to add or remove them. The bar above the list then applies Done, No action, Replied, Snooze etc. to
all of them.

Every triage action also has a button (thread header, row hover, multi-select bar, sidebar sync) whose tooltip
shows the hotkey, read from the same keymap registry.
