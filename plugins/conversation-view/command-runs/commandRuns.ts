import type { DatabaseSync } from 'node:sqlite';
import type { CommandRun, CommandRunStatus } from './types.ts';

/**
 * Commands typed into sessions with the Run button: the durable queue and the permanent record of what ran. The rows are
 * the core's `command_runs` table (migrations 4-6); the terminals plugin writes the `via = 'terminal'` ones.
 */

export type { CommandRun, CommandRunStatus };

export interface RunStoreDeps {
  db(): DatabaseSync;
  logEvent(workspaceId: string, type: string, detail?: string): void;
}

interface Row {
  id: number;
  session_id: string;
  workspace_id: string | null;
  command: string;
  status: CommandRunStatus;
  queued_at: string;
  done_at: string | null;
  error: string | null;
  output_at: string | null;
  output_lines: number | null;
  stderr: number | null;
  via: 'session' | 'terminal';
  exit_code: number | null;
  term_id: string | null;
}

const toRun = (r: Row): CommandRun => ({
  id: r.id,
  sessionId: r.session_id,
  workspaceId: r.workspace_id,
  command: r.command,
  status: r.status,
  queuedAt: r.queued_at,
  doneAt: r.done_at,
  error: r.error,
  outputAt: r.output_at,
  outputLines: r.output_lines,
  stderr: !!r.stderr,
  via: r.via,
  exitCode: r.exit_code,
  termId: r.term_id,
});

// Rows without the output itself (lists are polled); output_lines is computed here.
const COLS = `id, session_id, workspace_id, command, status, queued_at, done_at, error, output_at, stderr, via, exit_code, term_id,
  CASE WHEN output IS NULL THEN NULL ELSE length(output) - length(replace(output, char(10), '')) + 1 END AS output_lines`;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export type RunStore = ReturnType<typeof runStore>;

export function runStore(deps: RunStoreDeps) {
  const db = () => deps.db();
  function workspaceOf(sessionId: string): string | null {
    const r = db().prepare('SELECT workspace_id FROM sessions WHERE claude_session_id = ?').get(sessionId) as { workspace_id: string } | undefined;
    return r?.workspace_id ?? null;
  }

  /** A queued run of `command` in the session, or the existing one if it's already queued. */
  function enqueueRun(sessionId: string, command: string): CommandRun {
    const d = db();
    const existing = d.prepare(`SELECT ${COLS} FROM command_runs WHERE session_id = ? AND command = ? AND status = 'queued' AND via = 'session'`).get(sessionId, command) as Row | undefined;
    if (existing) return toRun(existing);
    const ws = workspaceOf(sessionId);
    const r = d
      .prepare(`INSERT INTO command_runs (session_id, workspace_id, command, status) VALUES (?, ?, ?, ?) RETURNING ${COLS}`)
      .get(sessionId, ws, command, 'queued') as unknown as Row;
    return toRun(r);
  }

  /** Close a run: typed into the session (ran), or given up on. Ran ones go in the workspace's activity log. */
  function finishRun(id: number, status: Exclude<CommandRunStatus, 'queued'>, error?: string): void {
    const r = db()
      .prepare(`UPDATE command_runs SET status = ?, done_at = ${NOW}, error = ? WHERE id = ? AND status = 'queued' RETURNING ${COLS}`)
      .get(status, error ?? null, id) as Row | undefined;
    if (r?.workspace_id && status === 'ran') deps.logEvent(r.workspace_id, 'command-ran', r.command);
  }

  function cancelRun(sessionId: string, command: string): boolean {
    const r = db()
      .prepare(`UPDATE command_runs SET status = 'cancelled', done_at = ${NOW} WHERE session_id = ? AND command = ? AND status = 'queued' AND via = 'session'`)
      .run(sessionId, command);
    return Number(r.changes) > 0;
  }

  /** The session's queued runs, oldest first. */
  function queuedRuns(sessionId: string): CommandRun[] {
    return (
      db().prepare(`SELECT ${COLS} FROM command_runs WHERE session_id = ? AND status = 'queued' ORDER BY id`).all(sessionId) as unknown as Row[]
    ).map(toRun);
  }

  /** Sessions with anything queued (to resume their queues after a restart). */
  function sessionsWithQueued(): string[] {
    return (db().prepare("SELECT DISTINCT session_id FROM command_runs WHERE status = 'queued'").all() as Array<{ session_id: string }>).map(
      (r) => r.session_id,
    );
  }

  /** The latest run of each command in the session. */
  function latestRuns(sessionId: string): CommandRun[] {
    return (
      db()
        .prepare(
          `SELECT ${COLS} FROM command_runs WHERE id IN (SELECT MAX(id) FROM command_runs WHERE session_id = ? GROUP BY command) ORDER BY id`,
        )
        .all(sessionId) as unknown as Row[]
    ).map(toRun);
  }

  /** Record a run's output once it's in the transcript. */
  function recordOutput(id: number, output: string, stderr: boolean, at: string | null): void {
    db()
      .prepare(`UPDATE command_runs SET output = ?, stderr = ?, output_at = COALESCE(?, ${NOW}) WHERE id = ?`)
      .run(output, stderr ? 1 : 0, at, id);
  }

  /** Ran runs still waiting for their output, typed in within the last `withinMs`. */
  function runsAwaitingOutput(withinMs: number, via: 'session' | 'terminal' = 'session'): CommandRun[] {
    const since = new Date(Date.now() - withinMs).toISOString();
    return (
      db()
        .prepare(`SELECT ${COLS} FROM command_runs WHERE status = 'ran' AND output IS NULL AND done_at >= ? AND via = ? ORDER BY id`)
        .all(since, via) as unknown as Row[]
    ).map(toRun);
  }

  /** One run with its recorded output (session-checked by the caller). */
  function runOutput(id: number): (CommandRun & { output: string | null }) | null {
    const r = db().prepare(`SELECT ${COLS}, output FROM command_runs WHERE id = ?`).get(id) as (Row & { output: string | null }) | undefined;
    return r ? { ...toRun(r), output: r.output } : null;
  }

  return { enqueueRun, finishRun, cancelRun, queuedRuns, sessionsWithQueued, latestRuns, recordOutput, runsAwaitingOutput, runOutput };
}
