# Private data: usage and habits

Besides your items, Nudge keeps two kinds of data about how you use it, both for you alone and both in your own
database: counters of which features you use, and a record of each triage decision (ids and counts, never text) so it
can later learn how you triage. Neither goes to any third party, and demo mode and automated test runs record nothing.
Back to the [README](../README.md).

## Usage data (private, local)

Nudge counts which of its own features you use and how, so you can see what earns its place. It is for you alone:

- **What is collected:** counters per UTC day, such as `done.kbd` (marked done with the keyboard), `snooze.touch`,
  `view.stats`, `search.run` (that a search ran), "Tell Nudge" calls, tool calls, failures and spend, sessions, rough
  active minutes, phone vs desktop and installed app vs browser tab. The list of possible keys is fixed in
  `shared/usage.ts`; the server drops anything else.
- **What is never collected:** comment text, search strings, author names, item ids, URLs or anything else
  you typed or read. Keys name a feature, never the thing it was used on.
- **Where it lives:** the `usage_daily` table in your own SQLite database. No third-party service, no network calls, no
  cookies. Demo mode and automated test runs record nothing.
- **Where to look:** the Usage section at the bottom of Stats (top features, keyboard vs button vs touch, per-day use,
  assistant spend, devices, and features you never used). It also shows what happened to items, read from the event log
  at view time, clearly labelled as such.
- **Reset:** Settings > Sync and data > Usage data > Reset usage data deletes every counter (and only the counters).
  The daily model-spend figure the cost cap reads lives in its own table (`llm_spend`) and is not reset.

## Habit context (private, local)

So Nudge can later learn how you triage, it records more than the new state: for each item you act on, one `decision`
event (the action, the view, its position in the list, the ids of up to ten items above it that were passed over,
whether it came from a key, button, the palette or touch, and whether it was a bulk action), and for each item you open,
an `open` event (the view and how long it stayed open). They go to `POST /api/item-events` and are stored in the
`item_events` table of your own database, as ids and counts only, never text. Demo mode and automated runs record
nothing. `npm run report:habits -- <db>` prints a read-only summary (action mix, time to first action, snooze returns,
rank of decisions, items passed over, open dwell) from a copy of the database.

Your own state, reply and snooze events also record what the suggestion called the item and which prompt version asked
(`suggestedCategory`, `suggestedPrompt`), and state and reply events the thread's size when you acted (`threadSize`), so
Insights can say which categories you overrule and whether thread size changes what you do. The Insights section reads
all of this at view time, in your browser's time zone, and writes nothing.

The offline tools that study this data are in [Development](DEVELOPMENT.md#learning-how-you-triage-offline-tooling).
