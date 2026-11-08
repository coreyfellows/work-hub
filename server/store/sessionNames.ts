import { getDb } from './db.ts';

/** Names you gave sessions in the app, by full session id. They override the name `claude agents` reports. */

export function sessionNames(): Map<string, string> {
  const rows = getDb().prepare('SELECT session_id, name FROM session_names').all() as Array<{ session_id: string; name: string }>;
  return new Map(rows.map((r) => [r.session_id, r.name]));
}

/** Set a session's name; an empty name removes the override. */
export function setSessionName(sessionId: string, name: string): void {
  const n = name.trim();
  if (!n) getDb().prepare('DELETE FROM session_names WHERE session_id = ?').run(sessionId);
  else getDb().prepare('INSERT INTO session_names (session_id, name) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET name = excluded.name').run(sessionId, n);
}
