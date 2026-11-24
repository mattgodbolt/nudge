// Reads the raw pull on stdin and prints a copy with everything identifying removed, so the PM agent only ever sees
// counts. Labels (repos, videos, channels, commenters, thread titles) become ranks; the shape of the distribution
// (who dominates, how concentrated) survives, the names do not.
const raw = JSON.parse(
  await new Promise((res) => {
    let s = '';
    process.stdin.on('data', (c) => (s += c)).on('end', () => res(s));
  }),
);

const ranked = (rows, noun) =>
  rows.map((r, i) => {
    const { label, itemId, provider, ...rest } = r;
    return { [noun]: `${noun} #${i + 1}`, ...(provider ? { provider } : {}), ...rest };
  });

const out = structuredClone(raw);
const src = out.insights?.sources;
if (src) {
  for (const [key, noun] of [
    ['repos', 'repo'],
    ['videos', 'video'],
    ['channels', 'channel'],
    ['regulars', 'commenter'],
    ['threads', 'thread'],
  ]) {
    if (src[key]?.data?.rows) src[key].data.rows = ranked(src[key].data.rows, noun);
  }
}
if (Array.isArray(out.stats?.bySource)) {
  out.stats.bySource = out.stats.bySource.map((s, i) => ({ ...s, title: `channel #${i + 1}`, sourceId: i + 1 }));
}
// Pre-summed counters, so the agent does not add up hundreds of rows by hand.
if (Array.isArray(out.usage?.rows)) {
  const weekOf = (d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
  };
  const byKey = {};
  const weekly = {};
  for (const r of out.usage.rows) {
    byKey[r.key] = (byKey[r.key] ?? 0) + r.count;
    const w = (weekly[weekOf(r.day)] ??= {});
    w[r.key] = (w[r.key] ?? 0) + r.count;
  }
  out.usage.byKey = byKey;
  out.usage.weekly = weekly; // keyed by the Monday that starts each week
}
// Last line of defence: anything still shaped like a handle, URL or email is dropped rather than trusted.
// Generated prose (`sentence`) can quote a video title, so free text goes too: ids and enums here are short.
const scrub = (v) => {
  if (typeof v === 'string') return v.length > 40 || /https?:\/\/|@|\/|[‘’“”]/.test(v) ? '[removed]' : v;
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== 'sentence')
        .map(([k, x]) => [k, scrub(x)]),
    );
  return v;
};
console.log(JSON.stringify(scrub(out), null, 1));
