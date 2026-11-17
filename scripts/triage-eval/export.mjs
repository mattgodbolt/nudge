// Phase 0 of LLM triage (issues #9, #10): export a secrets-free, read-only slice of a Nudge database as JSONL, one
// item per line, with the thread context a classifier would see.
//
// Plain JS on purpose: it runs inside the production image (which has better-sqlite3 but no tsx or sources) against
// a COPY of a nightly backup, with the network off:
//
//   docker run --rm --network none -v /tmp/x:/x:ro -v $PWD/scripts/triage-eval:/s:ro -w /app --entrypoint node \
//     nudge:latest /s/export.mjs /x/snap.db > items.jsonl
//
// It never reads the settings table, tokens, drafts or channel ids. Only text that is already public (comments, PR and
// issue titles and bodies) leaves the database.
import Database from 'better-sqlite3';

const path = process.argv[2];
if (!path) {
  console.error('usage: export.mjs <db>');
  process.exit(2);
}
const db = new Database(path, { readonly: true, fileMustExist: true });

const cap = (s, n) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const THREAD_CONTEXT = 5;

const rows = db
  .prepare(
    `SELECT i.id, i.provider, i.kind, i.container_key, i.container_title, i.title, i.author, i.body_plain,
            i.occurred_at, i.source_state, i.reason, i.data, i.state, i.state_source, i.state_changed_at,
            c.thread_id, c.parent_id, c.author_channel_id, c.like_count, v.channel_title, v.published_at AS video_published_at,
            v.view_count AS video_views,
            EXISTS (SELECT 1 FROM sources s WHERE s.kind = 'channel' AND s.is_own = 1 AND s.yt_id = v.channel_id) AS own_channel
       FROM items i LEFT JOIN comments c ON c.id = i.id LEFT JOIN videos v ON i.provider = 'youtube' AND v.id = i.container_key
      WHERE i.is_own = 0 AND i.provider IN ('youtube', 'github')
      ORDER BY i.occurred_at`,
  )
  .all();

const threadStmt = db.prepare(
  `SELECT id, is_own, author_name, text_plain, published_at FROM comments WHERE thread_id = ? ORDER BY published_at`,
);
// Author history, computed only from what existed BEFORE each item (no peeking at what happened after it).
const allComments = db
  .prepare('SELECT id, thread_id, author_channel_id, is_own, published_at FROM comments ORDER BY published_at')
  .all();
const byAuthor = new Map();
const ownByThread = new Map();
for (const c of allComments) {
  if (c.is_own) {
    if (!ownByThread.has(c.thread_id)) ownByThread.set(c.thread_id, []);
    ownByThread.get(c.thread_id).push(c.published_at);
  } else if (c.author_channel_id) {
    if (!byAuthor.has(c.author_channel_id)) byAuthor.set(c.author_channel_id, []);
    byAuthor.get(c.author_channel_id).push(c);
  }
}
function authorHistory(authorId, at) {
  const earlier = (byAuthor.get(authorId) ?? []).filter((x) => x.published_at < at);
  // Earlier comments by this person that the owner answered (the owner's reply came after theirs and before now).
  const answered = earlier.filter((x) =>
    (ownByThread.get(x.thread_id) ?? []).some((t) => t > x.published_at && t < at),
  );
  return { authorPriorComments: earlier.length, authorPriorAnswered: answered.length };
}
const ghByAuthor = new Map();
for (const r of db.prepare("SELECT author, occurred_at FROM items WHERE provider = 'github' AND is_own = 0").all()) {
  if (!ghByAuthor.has(r.author)) ghByAuthor.set(r.author, []);
  ghByAuthor.get(r.author).push(r.occurred_at);
}
const threadCache = new Map();
const thread = (id) => {
  if (!threadCache.has(id)) threadCache.set(id, threadStmt.all(id));
  return threadCache.get(id);
};

for (const r of rows) {
  const out = {
    id: r.id,
    provider: r.provider,
    kind: r.kind,
    container: cap(r.container_title ?? r.container_key, 140),
    title: r.title ? cap(r.title, 200) : null,
    author: r.author,
    text: cap(r.body_plain, 1500),
    occurredAt: r.occurred_at,
    state: r.state,
    stateSource: r.state_source,
  };
  if (r.provider === 'youtube') {
    const t = r.thread_id ? thread(r.thread_id) : [];
    const me = t.findIndex((x) => x.id === r.id);
    const before = me < 0 ? [] : t.slice(Math.max(0, me - THREAD_CONTEXT), me);
    const later = me < 0 ? [] : t.slice(me + 1).filter((x) => x.is_own);
    out.channel = cap(r.channel_title, 80) || null;
    // Whether the video is on one of the owner's own channels: the owner can commit to making content there, not elsewhere.
    out.ownChannel = !!r.own_channel;
    out.meta = {
      ...authorHistory(r.author_channel_id, r.occurred_at),
      likes: r.like_count ?? 0,
      videoAgeDays: r.video_published_at
        ? Math.max(0, Math.round((Date.parse(r.occurred_at) - Date.parse(r.video_published_at)) / 864e5))
        : null,
      videoViews: r.video_views ?? null,
    };
    out.isReply = !!r.parent_id;
    out.thread = before.map((x) => ({ own: !!x.is_own, text: cap(x.text_plain, 300) }));
    // Ground truth, not classifier input: did the channel answer later in this thread?
    out.ownReply = later[0] ? cap(later[0].text_plain, 300) : null;
  } else {
    let g = {};
    try {
      g = JSON.parse(r.data ?? '{}').github ?? JSON.parse(r.data ?? '{}');
    } catch {
      /* leave empty */
    }
    out.meta = {
      authorPriorItems: (ghByAuthor.get(r.author) ?? []).filter((t) => t < r.occurred_at).length,
    };
    out.github = {
      association: g.association ?? null,
      authorType: g.authorType ?? null,
      labels: g.labels ?? [],
      comments: g.comments ?? 0,
      draft: !!g.draft,
      sourceState: r.source_state,
      reason: r.reason,
    };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}
