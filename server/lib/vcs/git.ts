/**
 * The git provider, over the helpers the core already uses (lib/git.ts, lib/worktreeCleanup.ts). Its prompt text stays
 * where it is today (workspaceSessions.ts, the workspace-setup plugin), so `agentInstructions` is empty.
 */
import { config } from '../../config.ts';
import { run } from '../exec.ts';
import { branchInfo } from '../git.ts';
import { inspectWorktree, removalBlock, removeWorktreeFolder } from '../worktreeCleanup.ts';
import type { SourceControlProvider, WorkingCopyState } from './types.ts';

/** Branches too generic to tie a session to a workspace by name alone. */
export const SHARED_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

const TTL_MS = 30_000;
const toplevel = new Map<string, { at: number; root: string | null }>();

/** `git rev-parse --show-toplevel` for `path`, cached briefly (null when it isn't in a git working tree). */
async function detect(path: string): Promise<string | null> {
  const hit = toplevel.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.root;
  const root = await run('git', ['-C', path, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 }).then((s) => s.trim() || null, () => null);
  toplevel.set(path, { at: Date.now(), root });
  return root;
}

async function inspect(root: string): Promise<WorkingCopyState> {
  const s = await inspectWorktree(root);
  const block = removalBlock(s, config.paths.worktrees, false);
  return { exists: s.exists, dirty: s.dirty, unsaved: s.unpushed, removable: block === null, block };
}

export const gitProvider: SourceControlProvider = {
  id: 'git',
  title: 'Git',
  detect,
  identity: async (root) => ({ repo: (await branchInfo(root)).repo }),
  line: async (root) => {
    const [{ branch }, head] = await Promise.all([
      branchInfo(root),
      run('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 }).then((s) => s.trim() || null, () => null),
    ]);
    return { line: branch, head };
  },
  sharedLines: SHARED_BRANCHES,
  inspect,
  removeWorkingCopy: async (root, { force }) => {
    const s = await inspectWorktree(root);
    const block = removalBlock(s, config.paths.worktrees, force);
    if (block) throw new Error(`can't remove ${root}: ${block}`);
    await removeWorktreeFolder(s, force);
  },
  agentInstructions: () => [],
  prereq: () =>
    run('git', ['--version'], { timeoutMs: 10_000 }).then(
      (s) => ({ ok: true, detail: s.trim() }),
      (e: unknown) => ({ ok: false, detail: `git not found: ${e instanceof Error ? e.message : String(e)}` }),
    ),
};
