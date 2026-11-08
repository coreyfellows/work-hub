/**
 * Fuzzy match: every character of `query` must appear in `text` in order (case-insensitive). Returns null
 * for no match, else a score where higher is better: bonuses for a match at the start, at a word boundary
 * and for consecutive characters, a small penalty for gaps and for long text.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    const boundary = at === 0 || /[^a-z0-9]/.test(t[at - 1]!);
    score += 1 + (boundary ? 6 : 0) + (at === prev + 1 ? 4 : 0) - Math.min(at - ti, 5) * 0.2;
    if (at === 0) score += 3;
    prev = at;
    ti = at + 1;
  }
  return score - t.length * 0.01;
}

/** Words are matched separately (each fuzzily, in any order) and their scores add up: "conv view" finds "conversation-view". */
export function multiFuzzyScore(query: string, text: string): number | null {
  let total = 0;
  for (const word of query.split(/\s+/).filter(Boolean)) {
    const s = fuzzyScore(word, text);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/** The best `limit` items for `query` (stable among ties). An empty query returns the first `limit` as they are. */
export function rank<T>(items: T[], query: string, text: (t: T) => string, limit = 30): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const score = multiFuzzyScore(query.trim(), text(item));
    if (score !== null) scored.push({ item, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.item);
}

/**
 * Like `rank`, but a match in `primary` (a command's label) always beats one that only matches in `secondary` (its group
 * and hint), so a command named after what you typed leads the ones merely filed under it.
 */
export function rankPreferring<T>(items: T[], query: string, primary: (t: T) => string, secondary: (t: T) => string, limit = 30): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const q = query.trim();
  const scored: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const first = multiFuzzyScore(q, primary(item));
    const score = first !== null ? first + 1000 : multiFuzzyScore(q, `${primary(item)} ${secondary(item)}`);
    if (score !== null) scored.push({ item, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.item);
}
