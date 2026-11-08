import { getDb } from './db.ts';

/** Worktrees a session is bound to: ones it created or pointed at, besides the folder it started in (see lib/sessionWorktrees.ts). */
export function bindSessionWorktree(sessionId: string, path: string): boolean {
  return Number(getDb().prepare('INSERT OR IGNORE INTO session_worktrees (claude_session_id, path) VALUES (?, ?)').run(sessionId, path).changes) > 0;
}

export function boundWorktrees(sessionId: string): string[] {
  return (getDb().prepare('SELECT path FROM session_worktrees WHERE claude_session_id = ?').all(sessionId) as Array<{ path: string }>).map((r) => r.path);
}

export function sessionsBoundTo(path: string): string[] {
  return (getDb().prepare('SELECT claude_session_id FROM session_worktrees WHERE path = ?').all(path) as Array<{ claude_session_id: string }>).map((r) => r.claude_session_id);
}

/** Forget every binding to a worktree (its folder was removed). */
export function unbindWorktree(path: string): void {
  getDb().prepare('DELETE FROM session_worktrees WHERE path = ?').run(path);
}

export function getScanOffset(sessionId: string): number {
  const r = getDb().prepare('SELECT byte_offset FROM session_worktree_scans WHERE claude_session_id = ?').get(sessionId) as { byte_offset: number } | undefined;
  return r ? Number(r.byte_offset) : 0;
}

export function setScanOffset(sessionId: string, offset: number): void {
  getDb()
    .prepare('INSERT INTO session_worktree_scans (claude_session_id, byte_offset) VALUES (?, ?) ON CONFLICT(claude_session_id) DO UPDATE SET byte_offset = excluded.byte_offset')
    .run(sessionId, offset);
}
