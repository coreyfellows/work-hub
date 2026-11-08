import { getDb } from './db.ts';

/** When you last looked at each Claude session (ms since epoch). A session that's said something since is unread. */

export function seenTimes(): Map<string, number> {
  const rows = getDb().prepare('SELECT session_id, seen_at FROM session_reads').all() as Array<{ session_id: string; seen_at: number }>;
  return new Map(rows.map((r) => [r.session_id, r.seen_at]));
}

/** Record that you've seen the session up to `at` (never moves backwards). */
export function markSeen(sessionId: string, at: number): void {
  getDb()
    .prepare('INSERT INTO session_reads (session_id, seen_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET seen_at = max(seen_at, excluded.seen_at)')
    .run(sessionId, at);
}

/** First sighting: from when it's counted as seen (sessions already around when the server started: now). */
export function markFirstSeen(first: Array<[sessionId: string, at: number]>): void {
  if (!first.length) return;
  const stmt = getDb().prepare('INSERT OR IGNORE INTO session_reads (session_id, seen_at) VALUES (?, ?)');
  for (const [id, at] of first) stmt.run(id, at);
}
