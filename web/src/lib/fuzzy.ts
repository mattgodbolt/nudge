/** Subsequence scorer: higher is better, null when `query` is not a subsequence of `text`. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return null;
    score += 1;
    if (idx === prev + 1) score += 3; // consecutive
    if (idx === 0 || /[\s:/\-_]/.test(t[idx - 1] ?? '')) score += 4; // word start
    score -= Math.min(idx - ti, 5) * 0.2; // gaps
    prev = idx;
    ti = idx + 1;
  }
  if (t.includes(q)) score += 6;
  if (t.startsWith(q)) score += 6;
  return score - t.length * 0.02;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (t: T) => string): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(query, text(item));
    if (s !== null) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
