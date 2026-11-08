/**
 * Worktree cleanup for a workspace (see lib/worktreeCleanup.ts for what is safe). `GET /api/workspaces/:id/worktrees`
 * lists each recorded worktree with its state and the open sessions working in it (none = orphaned);
 * `POST /api/workspaces/:id/worktrees/remove` ({ paths?, orphaned?, force? }) removes the chosen ones, or every orphaned
 * one that is safe (`orphaned`; never forced). `cleanupAfterClose` is what closing a session runs.
 */
import type { Hono } from 'hono';
import { config } from './config.ts';
import { inspectWorktree, isInside, openSessionsIn, removalBlock, removeWorktreeFolder, type LiveSession, type WorktreeState } from './lib/worktreeCleanup.ts';
import { CLEANUP_KEY } from './lib/folders.ts';
import { getSetting } from './settings.ts';
import { bindFromTranscript } from './lib/sessionWorktrees.ts';
import { boundWorktrees, sessionsBoundTo, unbindWorktree } from './store/sessionWorktrees.ts';
import { getWorkspace, logEvent, removeWorktreeRecord, type Workspace } from './store/workspaces.ts';

export interface WorktreeInfo {
  id: number;
  repo: string;
  path: string;
  branch: string | null;
  baseBranch: string | null;
  exists: boolean;
  dirty: boolean;
  unpushed: number;
  /** Why it can't be removed without force (null: safe to remove). */
  block: string | null;
  /** The open sessions working in it. Orphaned = none. */
  sessions: Array<{ sessionId: string; name: string; status: string }>;
  orphaned: boolean;
}

export interface RemoveResult {
  path: string;
  ok: boolean;
  reason?: string;
}

type Wt = Workspace['worktrees'][number];

async function describe(w: Wt, live: LiveSession[], except?: ReadonlySet<string>): Promise<{ info: WorktreeInfo; state: WorktreeState }> {
  const state = await inspectWorktree(w.path);
  const sessions = openSessionsIn(w.path, live, except, new Set(sessionsBoundTo(w.path))).map((s) => ({ sessionId: s.sessionId, name: s.name, status: s.status }));
  return {
    state,
    info: {
      id: w.id,
      repo: w.repo,
      path: w.path,
      branch: w.branch,
      baseBranch: w.baseBranch,
      exists: state.exists,
      dirty: state.dirty,
      unpushed: state.unpushed,
      block: removalBlock(state, config.paths.worktrees, false),
      sessions,
      orphaned: sessions.length === 0,
    },
  };
}

/** Remove one worktree if it is orphaned and (unless `force`) loses nothing. */
async function removeOne(ws: Workspace, w: Wt, live: LiveSession[], force: boolean, except?: ReadonlySet<string>): Promise<RemoveResult> {
  const { info, state } = await describe(w, live, except);
  if (!info.orphaned) return { path: w.path, ok: false, reason: 'a session is still open in it' };
  const block = removalBlock(state, config.paths.worktrees, force);
  if (block) return { path: w.path, ok: false, reason: block };
  try {
    await removeWorktreeFolder(state, force);
  } catch (e) {
    return { path: w.path, ok: false, reason: (e as Error).message.split('\n').slice(-2).join(' ') };
  }
  removeWorktreeRecord(ws.id, w.path);
  unbindWorktree(w.path);
  return { path: w.path, ok: true };
}

/**
 * A session was just closed: remove the worktrees it was in or bound to (made or moved into) that nothing else uses, if Settings → Folders says to and it loses
 * nothing. What stays is logged with the reason and shows as orphaned in the workspace.
 */
export async function cleanupAfterClose(workspaceId: string, closed: { sessionId: string; cwd: string }, live: LiveSession[]): Promise<{ removed: string[]; kept: RemoveResult[] }> {
  const out = { removed: [] as string[], kept: [] as RemoveResult[] };
  if (getSetting<boolean>(CLEANUP_KEY) === false) return out;
  const ws = getWorkspace(workspaceId);
  if (!ws) return out;
  await bindFromTranscript(ws.id, closed.sessionId).catch(() => {}); // pick up what it did since the last pass
  const bound = new Set(boundWorktrees(closed.sessionId));
  const except = new Set([closed.sessionId]);
  for (const w of ws.worktrees.filter((t) => bound.has(t.path) || (!!closed.cwd && isInside(t.path, closed.cwd)))) {
    const r = await removeOne(ws, w, live, false, except);
    if (r.ok) out.removed.push(w.path);
    // Another open session still references it: it stays until the last one closes.
    else if (r.reason === 'a session is still open in it') {
      const n = openSessionsIn(w.path, live, except, new Set(sessionsBoundTo(w.path))).length;
      logEvent(ws.id, 'worktree-held', `${w.path}: still used by ${n} other open session${n === 1 ? '' : 's'}`);
    } else {
      out.kept.push(r);
      logEvent(ws.id, 'worktree-kept', `${w.path}: ${r.reason}`);
    }
  }
  return out;
}

export function registerWorktreeRoutes(app: Hono, deps: { liveSessions: () => LiveSession[] }): void {
  app.get('/api/workspaces/:id/worktrees', async (c) => {
    const ws = getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'unknown workspace' }, 404);
    const live = deps.liveSessions();
    const worktrees = await Promise.all(ws.worktrees.map(async (w) => (await describe(w, live)).info));
    return c.json({ worktrees });
  });

  app.post('/api/workspaces/:id/worktrees/remove', async (c) => {
    const ws = getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'unknown workspace' }, 404);
    const body = (await c.req.json().catch(() => null)) as { paths?: unknown; orphaned?: unknown; force?: unknown } | null;
    const live = deps.liveSessions();
    const wantAll = body?.orphaned === true;
    const paths = Array.isArray(body?.paths) ? body!.paths.filter((p): p is string => typeof p === 'string') : [];
    if (!wantAll && paths.length === 0) return c.json({ error: 'give paths, or orphaned: true' }, 400);
    // Force only for worktrees named one by one; the bulk "orphaned" removal never discards anything.
    const force = body?.force === true && !wantAll;
    const targets = wantAll ? ws.worktrees : ws.worktrees.filter((w) => paths.includes(w.path));
    const results: RemoveResult[] = [];
    for (const w of targets) {
      if (wantAll && (await describe(w, live)).info.sessions.length > 0) continue;
      const r = await removeOne(ws, w, live, force);
      // The bulk button skips what it would lose; those stay listed, not reported as failures.
      if (!(wantAll && !r.ok)) results.push(r);
    }
    for (const p of paths) if (!ws.worktrees.some((w) => w.path === p)) results.push({ path: p, ok: false, reason: "not one of this workspace's worktrees" });
    return c.json({ results });
  });
}
