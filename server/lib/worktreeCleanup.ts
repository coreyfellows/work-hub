/**
 * Removing worktrees safely. A worktree is "orphaned" when no open session works inside it; removing one deletes its
 * folder, so it is only done without asking when nothing would be lost: the tree is clean (no changes, nothing untracked
 * except `node_modules`, which is reinstallable)
 * and every commit on it is also on another branch or a remote. Anything else needs an explicit `force`. Only linked
 * worktrees under the worktrees folder are ever touched, never a repo's own checkout. The branch itself is kept.
 */
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { run } from './exec.ts';

/** Sessions in these states are closed (same list as the UI's HIDDEN in web/src/status.ts). */
export const CLOSED_STATUSES = ['done', 'stopped'];

export interface LiveSession {
  sessionId: string;
  name: string;
  cwd: string;
  status: string;
}

export const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * The open sessions working in `path`: their cwd is the worktree or inside it, or they are bound to it (`bound`: ids of
 * sessions that created it or moved into it, see lib/sessionWorktrees.ts). `except` are ones just closed.
 */
export function openSessionsIn(path: string, live: LiveSession[], except: ReadonlySet<string> = new Set(), bound: ReadonlySet<string> = new Set()): LiveSession[] {
  return live.filter((s) => !except.has(s.sessionId) && !CLOSED_STATUSES.includes(s.status) && (bound.has(s.sessionId) || (!!s.cwd && isInside(path, resolve(s.cwd)))));
}

export interface WorktreeState {
  path: string;
  exists: boolean;
  /** A linked worktree (not the repo's own checkout). */
  linked: boolean;
  /** Uncommitted changes or untracked files (an untracked `node_modules` alone doesn't count). */
  dirty: boolean;
  /** Untracked `node_modules` is present: `git worktree remove` refuses those without `--force`. */
  nodeModules?: boolean;
  /** Commits on this worktree that no other branch or remote has. */
  unpushed: number;
  /** Where the repo's git dir is (for running `git worktree remove` from outside the worktree). */
  gitCommonDir: string | null;
}

/** A `?? path` status line whose path is a `node_modules` folder (or file, e.g. a symlink), at any depth. */
export const isUntrackedNodeModules = (line: string): boolean => line.startsWith('?? ') && /(^|\/)node_modules\/?$/.test(line.slice(3).replace(/^"|"$/g, ''));

const git = (cwd: string, args: string[], input?: string) => run('git', ['-C', cwd, ...args], { timeoutMs: 20_000, input });

export async function inspectWorktree(path: string): Promise<WorktreeState> {
  const base: WorktreeState = { path, exists: false, linked: false, dirty: false, unpushed: 0, gitCommonDir: null };
  if (!(await stat(path).then((s) => s.isDirectory(), () => false))) return base;
  base.exists = true;
  try {
    const [gitDir, common] = await Promise.all([
      git(path, ['rev-parse', '--absolute-git-dir']).then((s) => s.trim()),
      git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((s) => s.trim()),
    ]);
    base.gitCommonDir = common;
    base.linked = (await realpath(gitDir)) !== (await realpath(common));
    const lines = (await git(path, ['status', '--porcelain'])).split('\n').filter((l) => l.trim());
    const mine = lines.filter((l) => !isUntrackedNodeModules(l));
    base.nodeModules = mine.length < lines.length;
    base.dirty = mine.length > 0;
    const branch = (await git(path, ['branch', '--show-current']).catch(() => '')).trim();
    const refs = (await git(path, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).split('\n').filter((r) => r && r !== `refs/heads/${branch}`);
    base.unpushed = Number((await git(path, ['rev-list', '--count', 'HEAD', '--stdin'], refs.map((r) => `^${r}`).join('\n') + '\n')).trim()) || 0;
  } catch {
    // Not a git worktree any more (or git failed): treated as not linked, so it is never removed here.
    base.linked = false;
  }
  return base;
}

/** Why this worktree can't be removed now, or null. `force` waives only the "would lose work" reasons. */
export function removalBlock(s: WorktreeState, root: string, force: boolean): string | null {
  if (!isInside(resolve(root), resolve(s.path)) || resolve(root) === resolve(s.path)) return 'outside the worktrees folder';
  if (!s.exists) return null; // nothing on disk: only the record goes
  if (!s.linked) return "not a linked git worktree (a repo's own checkout is never removed)";
  if (force) return null;
  if (s.dirty) return 'uncommitted changes';
  if (s.unpushed > 0) return `${s.unpushed} commit${s.unpushed === 1 ? '' : 's'} not on any other branch or remote`;
  return null;
}

/** Remove the folder (and git's record of it). Callers check `removalBlock` first. */
export async function removeWorktreeFolder(s: WorktreeState, force: boolean): Promise<void> {
  if (!s.exists) {
    if (s.gitCommonDir) await run('git', ['--git-dir', s.gitCommonDir, 'worktree', 'prune'], { timeoutMs: 20_000 }).catch(() => {});
    return;
  }
  const common = s.gitCommonDir!;
  await run('git', ['--git-dir', common, 'worktree', 'remove', ...(force || s.nodeModules ? ['--force'] : []), s.path], { timeoutMs: 60_000, cwd: dirname(common) });
  await run('git', ['--git-dir', common, 'worktree', 'prune'], { timeoutMs: 20_000 }).catch(() => {});
}
