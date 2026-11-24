// Runs INSIDE the container (see pull.sh): reads the app's own API on loopback and prints one JSON document.
const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };
const get = async (p) => {
  const r = await fetch('http://127.0.0.1:4517' + p, { headers: H });
  return r.ok ? await r.json() : { error: r.status };
};
const tz = process.env.PM_TZ ?? 'UTC';
console.log(
  JSON.stringify({
    insights: await get(`/api/insights?range=all&tz=${encodeURIComponent(tz)}`),
    stats: await get('/api/stats'),
    quota: await get('/api/quota'),
    usage: await get('/api/usage'),
  }),
);
