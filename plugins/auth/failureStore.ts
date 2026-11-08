import type { DatabaseSync } from 'node:sqlite';
import type { FailureStore } from './failureBrake.ts';

/**
 * SQLite backing for the sign-in brake: the core's `auth_failures` table (core migration 11, created before plugins had
 * their own migrations; it stays where it is), so a restart can't reset the brake.
 */
export function sqliteFailureStore(db: () => DatabaseSync): FailureStore {
  return {
    since: (since) => (db().prepare('SELECT at FROM auth_failures WHERE at >= ?').all(since) as Array<{ at: number }>).map((r) => r.at),
    add: (at) => void db().prepare('INSERT INTO auth_failures (at) VALUES (?)').run(at),
    prune: (before) => void db().prepare('DELETE FROM auth_failures WHERE at < ?').run(before),
  };
}
