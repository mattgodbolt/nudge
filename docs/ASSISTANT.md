# Tell Nudge (todos and voice commands)

Tell Nudge is the one place Nudge takes plain words: press `c`, type or say what you want, and a small Anthropic model
turns it into one of a handful of actions (a todo, a snooze, done) that you can undo. It needs your Anthropic key and
the About you profile; without them your words are still kept, as a plain todo. Back to the [README](../README.md).

Press `c` (or the mic button on your phone) and say or type a command: "remind me in 3 days to ring the plumber", or,
with an item selected, "snooze this till Monday" / "done". Nudge sends the text to a small Anthropic model, which can
only do a few things: add a todo, snooze the selected item (for a time, or until activity, with a reason), mark it
done or no action needed, or keep what you said as a note. Each shows a toast with Undo. If the assistant is off or
fails, your words are saved as a plain todo, so nothing you say is lost.

- Add an Anthropic API key in **Settings > Connections > Assistant: Anthropic API key** (stored in the database, like
  the other keys; use a key with a small spend limit), and fill in **Settings > You > About you**. Without a key, `c`
  just saves a todo; with a key but no profile, Nudge says to fill it in and keeps your words in the box.
- Dictation uses the browser's built-in speech recognition (Chrome, Android, Safari), which Chrome sends to Google's
  servers. The phone keyboard's own mic button works in the same box if yours has none.
- A todo with a due time stays hidden (Snoozed) until then, then comes back with a notification. Todos appear under
  Todos in the sidebar and in the inbox, with your words kept alongside the cleaned-up title.
- The model never sees what other people wrote. For the selected item it is told only its kind and source (for
  example "a GitHub pull request"), and for your last action only what it was, so a hostile issue title cannot steer
  "done", "dismiss" or "snooze". The cost is that it cannot read or summarise an item. What it returns is checked
  against your command: a snooze reason, a todo title or its notes that use words you did not say are dropped (a
  todo then takes your command as its title), though the action itself still happens.
- In demo mode the assistant is a local stand-in that understands the same three commands, so no key is needed.
