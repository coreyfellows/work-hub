/**
 * Worktree cleanup for a workspace (see lib/worktreeCleanup.ts for what is safe). `GET /api/workspaces/:id/worktrees`
 * lists each recorded worktree with its state and the open sessions working in it (none = orphaned);
 * `POST /api/workspaces/:id/worktrees/remove` ({ paths?, orphaned?, force? }) removes the chosen ones, or every orphaned
 * one that is safe (`orphaned`; never forced, and never a plain folder). `cleanupAfterClose` is what closing a session runs.
 *
 * Git worktrees go through lib/worktreeCleanup.ts; other kinds through their source-control provider (`inspect`,
 * `removeWorkingCopy`: a plain folder's only forgets the record). A kind with no provider in force is never removed, nor
 * is a non-folder copy outside the worktrees folder.
 */
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import type { WorkingCopyState } from './lib/vcs/types.ts';
import { config } from './config.ts';
import { inspectWorktree, isInside, openSessionsIn, removalBlock, removeWorktreeFolder, type LiveSession, type WorktreeState } from './lib/worktreeCleanup.ts';
import { CLEANUP_KEY } from './lib/folders.ts';
import { getSetting } from './settings.ts';
import { getProvider } from './lib/vcs/registry.ts';
import { bindFromTranscript } from './lib/sessionWorktrees.ts';
import { boundWorktrees, sessionsBoundTo, unbindWorktree } from './store/sessionWorktrees.ts';
import { getWorkspace, logEvent, removeWorktreeRecord, type Workspace } from './store/workspaces.ts';

export interface WorktreeInfo {
  id: number;
  /** Its source-control kind (`git`, `folder`, a plugin's id). */
  vcs: string;
  repo: string | null;
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

/**
 * What removing a git worktree (`git`) or another kind's copy (`other`: its provider's view) would cost. `final`: the
 * block isn't the provider's (no provider in force, or its inspect failed), so not even `force` removes it.
 */
type OtherCopy = { kind: 'other'; state: WorkingCopyState; final: boolean };
type CopyState = { kind: 'git'; state: WorktreeState } | OtherCopy;

async function inspectOther(w: Wt): Promise<OtherCopy> {
  const provider = getProvider(w.vcs);
  const blocked = async (block: string): Promise<OtherCopy> => ({
    kind: 'other',
    final: true,
    state: { exists: await stat(w.path).then(() => true, () => false), dirty: false, unsaved: 0, removable: false, block },
  });
  if (!provider) return blocked(`no source-control provider "${w.vcs}" is in force (is its plugin off?)`);
  // Like git, a provider only ever removes copies inside the worktrees folder; a plain folder's removal touches no files.
  const root = resolve(config.paths.worktrees);
  if (w.vcs !== 'folder' && (!isInside(root, resolve(w.path)) || resolve(w.path) === root)) return blocked('outside the worktrees folder');
  return provider.inspect(w.path).then(
    (state): OtherCopy => ({ kind: 'other', state, final: false }),
    (e: Error) => blocked(`couldn't inspect it: ${e.message}`),
  );
}

async function describe(w: Wt, live: LiveSession[], except?: ReadonlySet<string>): Promise<{ info: WorktreeInfo; copy: CopyState }> {
  const sessions = openSessionsIn(w.path, live, except, new Set(sessionsBoundTo(w.path))).map((s) => ({ sessionId: s.sessionId, name: s.name, status: s.status }));
  if (w.vcs !== 'git') {
    const copy = await inspectOther(w);
    const state = copy.state;
    return {
      copy,
      info: {
        id: w.id,
        vcs: w.vcs,
        repo: w.repo,
        path: w.path,
        branch: w.branch,
        baseBranch: w.baseBranch,
        exists: state.exists,
        dirty: state.dirty,
        unpushed: state.unsaved,
        block: state.block,
        sessions,
        orphaned: sessions.length === 0,
      },
    };
  }
  const state = await inspectWorktree(w.path);
  return {
    copy: { kind: 'git', state },
    info: {
      id: w.id,
      vcs: w.vcs,
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
  const { info, copy } = await describe(w, live, except);
  if (!info.orphaned) return { path: w.path, ok: false, reason: 'a session is still open in it' };
  try {
    if (copy.kind === 'git') {
      const block = removalBlock(copy.state, config.paths.worktrees, force);
      if (block) return { path: w.path, ok: false, reason: block };
      await removeWorktreeFolder(copy.state, force);
    } else {
      // `force` waives only the provider's own block (it throws if it still can't); a final one stands.
      const provider = getProvider(w.vcs);
      if (copy.state.block && (copy.final || !force)) return { path: w.path, ok: false, reason: copy.state.block };
      if (!provider) return { path: w.path, ok: false, reason: `no source-control provider "${w.vcs}" is in force` };
      await provider.removeWorkingCopy(w.path, { force });
    }
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
  // Only git worktrees: closing a session never removes (or forgets) another kind's copy; those stay listed.
  for (const w of ws.worktrees.filter((t) => t.vcs === 'git' && (bound.has(t.path) || (!!closed.cwd && isInside(t.path, closed.cwd))))) {
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
      // The bulk button never forgets a plain folder; those are forgotten one at a time, explicitly.
      if (wantAll && w.vcs === 'folder') continue;
      if (wantAll && (await describe(w, live)).info.sessions.length > 0) continue;
      const r = await removeOne(ws, w, live, force);
      // The bulk button skips what it would lose; those stay listed, not reported as failures.
      if (!(wantAll && !r.ok)) results.push(r);
    }
    for (const p of paths) if (!ws.worktrees.some((w) => w.path === p)) results.push({ path: p, ok: false, reason: "not one of this workspace's worktrees" });
    return c.json({ results });
  });
}
