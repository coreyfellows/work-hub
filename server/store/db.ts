import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';

/**
 * The workspace model lives in one SQLite file. Both the server and the `wh` CLI (which agents call)
 * open it; WAL mode lets them read and write concurrently. Schema changes go in MIGRATIONS, applied in
 * order and tracked with PRAGMA user_version; never edit an applied migration, add a new one.
 */

export const DB_PATH = config.dbFile;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,              -- slug, e.g. "tkt-14393" or "work-hub"
    title       TEXT NOT NULL,
    origin      TEXT NOT NULL,                 -- 'ticket' | 'prompt' | 'backfill'
    ticket_key  TEXT,
    prompt      TEXT,
    status      TEXT NOT NULL DEFAULT 'active',-- 'setting-up' | 'active' | 'parked' | 'done'
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE worktrees (
    id            INTEGER PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repo          TEXT NOT NULL,               -- owner/name
    path          TEXT NOT NULL UNIQUE,
    branch        TEXT,
    base_branch   TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE sessions (
    id                 INTEGER PRIMARY KEY,
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    claude_session_id  TEXT NOT NULL UNIQUE,   -- full UUID; the short id is its first 8 chars
    role               TEXT NOT NULL DEFAULT 'main', -- 'explorer' | 'main' | 'review' | ...
    name               TEXT,
    cwd                TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE views (
    id            INTEGER PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,               -- how the workspace is displayed (none yet)
    ref           TEXT NOT NULL,               -- e.g. "workspace:21"
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (kind, ref)
  );
  CREATE TABLE links (
    id            INTEGER PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,               -- 'pr' | 'jira' | 'url'
    url           TEXT NOT NULL,
    label         TEXT,
    UNIQUE (workspace_id, url)
  );
  CREATE TABLE events (
    id            INTEGER PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    type          TEXT NOT NULL,
    detail        TEXT
  );
  CREATE INDEX events_ws ON events(workspace_id, at);
  `,
  // 2: work-hub no longer uses cmux; forget the cmux workspaces the backfill recorded.
  `DELETE FROM views WHERE kind = 'cmux';`,
  // 3: the Jira epic a workspace's ticket belongs to (looked up once, or recorded by the setup agent).
  `
  ALTER TABLE workspaces ADD COLUMN epic_key TEXT;
  ALTER TABLE workspaces ADD COLUMN epic_title TEXT;
  ALTER TABLE workspaces ADD COLUMN epic_checked_at TEXT;
  `,
  // 4: commands run with the Run button ("! <command>" typed into a session), queued until it's idle, kept for good.
  `
  CREATE TABLE command_runs (
    id            INTEGER PRIMARY KEY,
    session_id    TEXT NOT NULL,                  -- full Claude session UUID (may not belong to a workspace)
    workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    command       TEXT NOT NULL,
    status        TEXT NOT NULL,                  -- queued | ran | failed | cancelled | expired
    queued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    done_at       TEXT,                           -- when it was typed (ran), or gave up (failed/cancelled/expired)
    error         TEXT
  );
  CREATE INDEX command_runs_session ON command_runs(session_id, command);
  CREATE INDEX command_runs_queued ON command_runs(status) WHERE status = 'queued';
  `,
  // 5: a Run's result: its output (stdout then stderr, from the transcript once it lands), kept with the run.
  `
  ALTER TABLE command_runs ADD COLUMN output TEXT;
  ALTER TABLE command_runs ADD COLUMN output_at TEXT;
  ALTER TABLE command_runs ADD COLUMN stderr INTEGER;
  `,
  // 6: runs started in a workspace terminal (the card's Terminal button), whose output comes from bin/wh-term-run.
  `
  ALTER TABLE command_runs ADD COLUMN via TEXT NOT NULL DEFAULT 'session';  -- session | terminal
  ALTER TABLE command_runs ADD COLUMN exit_code INTEGER;                    -- terminal runs only
  ALTER TABLE command_runs ADD COLUMN term_id TEXT;
  `,
  // 7: when you last looked at each Claude session (ms), so one that's said something since shows as unread.
  `
  CREATE TABLE session_reads (
    session_id  TEXT PRIMARY KEY,                 -- full Claude session UUID
    seen_at     INTEGER NOT NULL
  );
  `,
  // 8: UI preferences shared by every device (the workspace panel layout).
  `
  CREATE TABLE ui_prefs (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL                          -- JSON
  );
  `,
  // 9: background jobs (handoff, new session, PR session, review), so the header tray survives a restart.
  `
  CREATE TABLE jobs (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    detail       TEXT,
    workspace_id TEXT,                            -- no FK: the job outlives nothing, but never blocks a workspace delete
    status       TEXT NOT NULL,                   -- running | done | failed
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    error        TEXT,
    link_to      TEXT,
    link_label   TEXT
  );
  `,
  // 10: where a resumable job (a handoff) has got to, JSON, so a restart can pick it up; null once it finishes.
  `
  ALTER TABLE jobs ADD COLUMN payload TEXT;
  `,
  // 11: failed sign-ins (ms), so the brute-force brake survives a restart.
  `
  CREATE TABLE auth_failures (
    at  INTEGER NOT NULL
  );
  CREATE INDEX auth_failures_at ON auth_failures(at);
  `,
  `
  CREATE TABLE plugin_migrations (
    plugin   TEXT PRIMARY KEY,
    version  INTEGER NOT NULL
  );
  `,
  // 13: values set in Settings (key `<group or plugin id>.<key>`, JSON), under env vars and plugins.json.
  `
  CREATE TABLE app_settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL                          -- JSON
  );
  `,
  `
  -- Which worktrees a session created or pointed at (found in its transcript), whatever folder it was started in.
  CREATE TABLE session_worktrees (
    claude_session_id TEXT NOT NULL,
    path              TEXT NOT NULL,
    PRIMARY KEY (claude_session_id, path)
  );
  -- How far into each session's transcript that was read.
  CREATE TABLE session_worktree_scans (
    claude_session_id TEXT PRIMARY KEY,
    byte_offset       INTEGER NOT NULL
  );
  `,
  // 15: which Claude session logged an event (full session UUID; null when unknown), so `wh claim` / `wh done` and
  // other session-made events can be shown per session (the session-awareness plugin reads them).
  `ALTER TABLE events ADD COLUMN session_id TEXT;`,
  // 16: names you gave sessions in the app (override what `claude agents` reports; the session itself is untouched).
  `CREATE TABLE session_names (
    session_id TEXT PRIMARY KEY,
    name       TEXT NOT NULL
  );`,
];

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** Apply any migrations the database hasn't seen (exported so tests can build an in-memory one). */
export function migrate(d: DatabaseSync): void {
  const { user_version: version } = d.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    d.exec('BEGIN');
    try {
      d.exec(MIGRATIONS[v]);
      d.exec(`PRAGMA user_version = ${v + 1}`);
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }
}
