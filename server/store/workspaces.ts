import { hubEvents } from '../lib/events.ts';
import { getDb } from './db.ts';

/** The explicit workspace model. Live state (session status, PR checks) is overlaid by the UI. */

export type WorkspaceStatus = 'setting-up' | 'active' | 'parked' | 'done';

export interface Worktree {
  id: number;
  vcs: string;
  repo: string | null;
  path: string;
  branch: string | null;
  baseBranch: string | null;
}

export interface WorkspaceSession {
  id: number;
  claudeSessionId: string;
  shortId: string;
  role: string;
  name: string | null;
  cwd: string | null;
}

export interface View {
  id: number;
  kind: string;
  ref: string;
}

export interface Link {
  id: number;
  kind: string;
  url: string;
  label: string | null;
}

export interface WorkspaceEvent {
  at: string;
  type: string;
  detail: string | null;
  /** The Claude session that logged it (full UUID), when known. */
  sessionId: string | null;
}

export interface Workspace {
  id: string;
  title: string;
  origin: string;
  ticketKey: string | null;
  prompt: string | null;
  /** The ticket's Jira epic; epicCheckedAt is set once it has been looked up (even if there's none). */
  epicKey: string | null;
  epicTitle: string | null;
  epicCheckedAt: string | null;
  status: WorkspaceStatus;
  /** The workspace's source control ('git', 'jj', 'folder'…); null until one is chosen. */
  vcs: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  worktrees: Worktree[];
  sessions: WorkspaceSession[];
  views: View[];
  links: Link[];
  events: WorkspaceEvent[];
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';
}

const STOP_WORDS = new Set(
  'a an and are as at be but by can could do for from get got had has have how i if in into is it its just like make me my need of on or our please so that the their then there these this those to us want was we what when which will with would you your'.split(' '),
);
const TICKET_IN_TEXT = /\b[A-Za-z][A-Za-z0-9]+-\d+\b/;

/**
 * A short, readable id base for a new workspace: the ticket key first when there is one (given, or named in the title or
 * prompt: "tkt-13522"), then up to three meaningful words ("tkt-13522-tickets-phase-verify"). A ticket workspace whose title
 * is just its key is only the key. No ticket and no usable words fall back to the whole title.
 */
export function suggestId(input: { title: string; ticketKey?: string | null; prompt?: string | null }): string {
  const explicit = input.ticketKey?.trim() || null;
  const text = `${input.title}\n${input.prompt ?? ''}`;
  const key = explicit ?? TICKET_IN_TEXT.exec(text)?.[0] ?? null;
  if (explicit && slugify(input.title) === slugify(explicit)) return slugify(explicit);
  const withoutKey = key ? input.title.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ') : input.title;
  const words = (withoutKey.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  const picked = words.slice(0, key ? 3 : 4);
  const parts = [...(key ? [key] : []), ...picked];
  return parts.length ? parts.join('-') : input.title;
}

/** A slug not yet taken: "tkt-14393", then "tkt-14393-2", … */
export function uniqueId(base: string): string {
  const db = getDb();
  const slug = slugify(base);
  for (let i = 1; ; i++) {
    const id = i === 1 ? slug : `${slug}-${i}`;
    if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) return id;
  }
}

function touch(id: string): void {
  getDb().prepare("UPDATE workspaces SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
}

/** `sessionId`: the Claude session (full UUID) that made the event, when known (`wh` resolves it from its environment). */
export function logEvent(workspaceId: string, type: string, detail?: string, sessionId?: string | null): void {
  getDb()
    .prepare('INSERT INTO events (workspace_id, type, detail, session_id) VALUES (?, ?, ?, ?)')
    .run(workspaceId, type, detail ?? null, sessionId ?? null);
  touch(workspaceId);
  hubEvents.emit('workspace-event', { workspaceId, type, detail: detail ?? null, sessionId: sessionId ?? null });
}

/** A workspace's events, newest first, optionally only some types or one session's; `limit` defaults to 50. */
export function listEvents(workspaceId: string, opts: { types?: string[]; sessionId?: string; limit?: number } = {}): WorkspaceEvent[] {
  const where = ['workspace_id = ?'];
  const args: Array<string | number> = [workspaceId];
  if (opts.types?.length) {
    where.push(`type IN (${opts.types.map(() => '?').join(', ')})`);
    args.push(...opts.types);
  }
  if (opts.sessionId) {
    where.push('session_id = ?');
    args.push(opts.sessionId);
  }
  args.push(opts.limit ?? 50);
  const rows = getDb()
    .prepare(`SELECT at, type, detail, session_id FROM events WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...args) as Row[];
  return rows.map(eventRow);
}

const eventRow = (e: Row): WorkspaceEvent => ({ at: String(e.at), type: String(e.type), detail: str(e.detail), sessionId: str(e.session_id) });

export function createWorkspace(input: {
  id?: string;
  title: string;
  origin: 'ticket' | 'prompt' | 'backfill' | 'pr' | 'review';
  ticketKey?: string | null;
  prompt?: string | null;
  status?: WorkspaceStatus;
  notes?: string | null;
  vcs?: string | null;
}): string {
  const id = input.id ?? uniqueId(suggestId(input));
  getDb()
    .prepare('INSERT INTO workspaces (id, title, origin, ticket_key, prompt, status, notes, vcs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.title, input.origin, input.ticketKey ?? null, input.prompt ?? null, input.status ?? 'active', input.notes ?? null, input.vcs ?? null);
  logEvent(id, 'created', input.origin);
  return id;
}

/**
 * Delete a workspace record and everything recorded under it (worktrees, sessions, links, events: the foreign keys
 * cascade). Files on disk are not touched. For undoing a creation that failed half way, not for closing work (that's
 * status `done`).
 */
export function deleteWorkspace(id: string): void {
  getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id);
}

export function setStatus(id: string, status: WorkspaceStatus): void {
  getDb().prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, id);
  logEvent(id, 'status', status);
}

export function setWorkspaceVcs(id: string, vcs: string | null): void {
  getDb().prepare('UPDATE workspaces SET vcs = ? WHERE id = ?').run(vcs, id);
  touch(id);
}

export function updateWorkspace(id: string, patch: { title?: string; notes?: string | null }): void {
  const db = getDb();
  if (patch.title !== undefined) db.prepare('UPDATE workspaces SET title = ? WHERE id = ?').run(patch.title, id);
  if (patch.notes !== undefined) db.prepare('UPDATE workspaces SET notes = ? WHERE id = ?').run(patch.notes, id);
  touch(id);
}

export function addWorktree(workspaceId: string, w: { repo?: string | null; path: string; branch?: string | null; baseBranch?: string | null; vcs?: string }): void {
  getDb()
    .prepare(
      `INSERT INTO worktrees (workspace_id, repo, path, branch, base_branch, vcs) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET workspace_id = excluded.workspace_id, repo = excluded.repo, vcs = excluded.vcs,
         branch = COALESCE(excluded.branch, branch), base_branch = COALESCE(excluded.base_branch, base_branch)`,
    )
    .run(workspaceId, w.repo ?? null, w.path, w.branch ?? null, w.baseBranch ?? null, w.vcs ?? 'git');
  logEvent(workspaceId, 'worktree', `${w.repo ?? ''} ${w.branch ?? ''} ${w.path}`.trim());
}

/** Forget a worktree (its folder was removed). */
export function removeWorktreeRecord(workspaceId: string, path: string): void {
  const w = getDb().prepare('SELECT repo, branch FROM worktrees WHERE workspace_id = ? AND path = ?').get(workspaceId, path) as { repo: string | null; branch: string | null } | undefined;
  if (!w) return;
  getDb().prepare('DELETE FROM worktrees WHERE workspace_id = ? AND path = ?').run(workspaceId, path);
  logEvent(workspaceId, 'worktree-removed', `${w.repo ?? ''} ${w.branch ?? ''} ${path}`.trim());
}

export function addSession(workspaceId: string, s: { claudeSessionId: string; role?: string; name?: string | null; cwd?: string | null }): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (workspace_id, claude_session_id, role, name, cwd) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(claude_session_id) DO UPDATE SET workspace_id = excluded.workspace_id, role = excluded.role,
         name = COALESCE(excluded.name, name), cwd = COALESCE(excluded.cwd, cwd)`,
    )
    .run(workspaceId, s.claudeSessionId, s.role ?? 'main', s.name ?? null, s.cwd ?? null);
  logEvent(workspaceId, 'session', `${s.role ?? 'main'} ${s.claudeSessionId.slice(0, 8)} ${s.name ?? ''}`.trim());
}

export function addLink(workspaceId: string, l: { kind: string; url: string; label?: string | null }): void {
  getDb()
    .prepare('INSERT INTO links (workspace_id, kind, url, label) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, url) DO NOTHING')
    .run(workspaceId, l.kind, l.url, l.label ?? null);
}

export function listWorkspaces(opts: { includeDone?: boolean } = {}): Workspace[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM workspaces ${opts.includeDone ? '' : "WHERE status != 'done'"}
       ORDER BY CASE status WHEN 'setting-up' THEN 0 WHEN 'active' THEN 1 WHEN 'parked' THEN 2 ELSE 3 END, updated_at DESC`,
    )
    .all() as Row[];
  return rows.map((r) => hydrate(r));
}

export function getWorkspace(id: string): Workspace | null {
  const r = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined;
  return r ? hydrate(r) : null;
}

function hydrate(r: Row): Workspace {
  const db = getDb();
  const id = String(r.id);
  return {
    id,
    title: String(r.title),
    origin: String(r.origin),
    ticketKey: str(r.ticket_key),
    prompt: str(r.prompt),
    epicKey: str(r.epic_key),
    epicTitle: str(r.epic_title),
    epicCheckedAt: str(r.epic_checked_at),
    status: String(r.status) as WorkspaceStatus,
    vcs: str(r.vcs),
    notes: str(r.notes),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    worktrees: (db.prepare('SELECT * FROM worktrees WHERE workspace_id = ? ORDER BY id').all(id) as Row[]).map((w) => ({
      id: Number(w.id),
      vcs: String(w.vcs),
      repo: str(w.repo),
      path: String(w.path),
      branch: str(w.branch),
      baseBranch: str(w.base_branch),
    })),
    sessions: (db.prepare('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY id').all(id) as Row[]).map((s) => ({
      id: Number(s.id),
      claudeSessionId: String(s.claude_session_id),
      shortId: String(s.claude_session_id).slice(0, 8),
      role: String(s.role),
      name: str(s.name),
      cwd: str(s.cwd),
    })),
    views: (db.prepare('SELECT * FROM views WHERE workspace_id = ? ORDER BY id').all(id) as Row[]).map((v) => ({
      id: Number(v.id),
      kind: String(v.kind),
      ref: String(v.ref),
    })),
    links: (db.prepare('SELECT * FROM links WHERE workspace_id = ? ORDER BY id').all(id) as Row[]).map((l) => ({
      id: Number(l.id),
      kind: String(l.kind),
      url: String(l.url),
      label: str(l.label),
    })),
    events: (db.prepare('SELECT at, type, detail, session_id FROM events WHERE workspace_id = ? ORDER BY at DESC, id DESC LIMIT 20').all(id) as Row[]).map(eventRow),
  };
}

/** The workspace that owns a worktree, by path or by repo + branch. */
export function findWorkspaceByWorktree(w: { path?: string; repo?: string; branch?: string }): string | null {
  const db = getDb();
  const byPath = w.path ? (db.prepare('SELECT workspace_id FROM worktrees WHERE path = ?').get(w.path) as Row | undefined) : undefined;
  if (byPath) return String(byPath.workspace_id);
  if (w.repo && w.branch) {
    const r = db
      .prepare("SELECT workspace_id FROM worktrees WHERE vcs = 'git' AND lower(repo) = lower(?) AND branch = ? ORDER BY id DESC")
      .get(w.repo, w.branch) as Row | undefined;
    if (r) return String(r.workspace_id);
  }
  return null;
}

/** Record a workspace's epic (null = checked, no epic). */
export function setEpic(id: string, epicKey: string | null, epicTitle: string | null): void {
  getDb()
    .prepare("UPDATE workspaces SET epic_key = ?, epic_title = ?, epic_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(epicKey, epicTitle, id);
}

/** Ticket workspaces whose epic hasn't been looked up, or was looked up more than `maxAgeDays` ago. */
export function workspacesNeedingEpic(maxAgeDays: number): Array<{ id: string; ticketKey: string }> {
  return (
    getDb()
      .prepare(
        `SELECT id, ticket_key FROM workspaces
         WHERE ticket_key IS NOT NULL AND status != 'done'
           AND (epic_checked_at IS NULL OR epic_checked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))`,
      )
      .all(`-${maxAgeDays} days`) as Row[]
  ).map((r) => ({ id: String(r.id), ticketKey: String(r.ticket_key) }));
}

/** Every recorded session id → its workspace. */
export function sessionOwners(): Map<string, string> {
  const rows = getDb().prepare('SELECT claude_session_id, workspace_id FROM sessions').all() as Row[];
  return new Map(rows.map((r) => [String(r.claude_session_id), String(r.workspace_id)]));
}

/** Every recorded worktree, across workspaces. */
export function allWorktrees(): Array<{ workspaceId: string; vcs: string; repo: string | null; path: string; branch: string | null }> {
  return (getDb().prepare('SELECT workspace_id, vcs, repo, path, branch FROM worktrees ORDER BY id').all() as Row[]).map((r) => ({
    workspaceId: String(r.workspace_id),
    vcs: String(r.vcs),
    repo: str(r.repo),
    path: String(r.path),
    branch: str(r.branch),
  }));
}

/** URLs linked to any workspace (so a PR is never claimed by a second one). */
export function linkedUrls(): Set<string> {
  return new Set((getDb().prepare('SELECT url FROM links').all() as Row[]).map((r) => String(r.url)));
}

/** Keep a recorded worktree's branch current (e.g. after `git branch -m`), without logging an event. */
export function setWorktreeBranch(path: string, branch: string): void {
  getDb().prepare('UPDATE worktrees SET branch = ? WHERE path = ?').run(branch, path);
}

/** The workspace (not done first, newest first) that links this URL. */
export function findWorkspaceByLink(url: string): string | null {
  const r = getDb()
    .prepare(
      `SELECT l.workspace_id FROM links l JOIN workspaces w ON w.id = l.workspace_id
       WHERE rtrim(l.url, '/') = rtrim(?, '/') ORDER BY (w.status = 'done'), w.updated_at DESC`,
    )
    .get(url) as Row | undefined;
  return r ? String(r.workspace_id) : null;
}

/** Plain folders the user trusted for `claude --bg` (a git worktree is trusted by `wh trust`; a folder has no such step). */
export function trustFolder(path: string): void {
  getDb().prepare('INSERT OR IGNORE INTO trusted_folders (path) VALUES (?)').run(path);
}

export function isTrustedFolder(path: string): boolean {
  return getDb().prepare('SELECT 1 FROM trusted_folders WHERE path = ?').get(path) !== undefined;
}
