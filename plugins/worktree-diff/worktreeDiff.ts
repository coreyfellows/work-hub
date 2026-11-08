import { baseRef, run, type Workspace, type Worktree } from '../../plugin-api/server.ts';

/** What to compare in a worktree. */
export type DiffMode = 'base' | 'commit' | 'staged';

export interface WorktreeDiffFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  /** Hunks only (starts at the first @@); '' for binary files and files too large to show. */
  patch: string;
}

export interface WorktreeDiff {
  mode: DiffMode;
  /** Human description of what's compared, e.g. "working tree vs main (merge base a1b2c3d)". */
  label: string;
  files: WorktreeDiffFile[];
  /** Files git doesn't track yet (they're not in any of the diffs). */
  untracked: string[];
  /** Why the diff is empty or unavailable, if it is. */
  note: string | null;
}

const MAX_PATCH = 400_000; // per file; beyond this the file is listed without its patch

const git = (cwd: string, args: string[]) => run('git', ['-C', cwd, ...args], { timeoutMs: 20_000 });

async function resolves(cwd: string, ref: string): Promise<boolean> {
  if (!ref || ref.startsWith('-')) return false;
  return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(() => true, () => false);
}

const changesCache = new Map<string, { at: number; value: boolean | null }>();

/**
 * Whether a PR from the worktree's branch would have any changes: the branch's diff against its merge base with
 * the base branch (what GitHub's compare page shows) isn't empty. null when git can't tell. Cached 20s per worktree.
 */
export async function branchHasChanges(t: Worktree): Promise<boolean | null> {
  if (!t.branch || t.branch.startsWith('-')) return null;
  const key = `${t.path}\0${t.branch}\0${t.baseBranch ?? ''}`;
  const hit = changesCache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return hit.value;
  const base = await baseRef(t.path, t.baseBranch).catch(() => null);
  const value = base
    ? await git(t.path, ['diff', '--name-only', `${base}...refs/heads/${t.branch}`, '--']).then((out) => out.trim() !== '', () => null)
    : null;
  changesCache.set(key, { at: Date.now(), value });
  return value;
}

/** Split `git diff` output into files; headers are dropped so each patch starts at its first hunk. */
export function parseGitDiff(raw: string): WorktreeDiffFile[] {
  const files: WorktreeDiffFile[] = [];
  for (const chunk of raw.split(/^diff --git /m).slice(1)) {
    const nl = chunk.indexOf('\n');
    const head = chunk.slice(0, nl < 0 ? undefined : nl);
    const rest = nl < 0 ? '' : chunk.slice(nl + 1);
    const at = rest.search(/^@@ /m);
    const header = at < 0 ? rest : rest.slice(0, at);
    let patch = at < 0 ? '' : rest.slice(at);
    const rename = /^rename from (.+)$/m.exec(header)?.[1] ?? null;
    const renameTo = /^rename to (.+)$/m.exec(header)?.[1] ?? null;
    const m = /^a\/(.+) b\/(.+)$/.exec(head);
    const path = renameTo ?? m?.[2] ?? head;
    let additions = 0;
    let deletions = 0;
    for (const l of patch.split('\n')) {
      if (l.startsWith('+')) additions++;
      else if (l.startsWith('-')) deletions++;
    }
    if (patch.length > MAX_PATCH) patch = '';
    files.push({
      path,
      previousPath: rename,
      status: /^new file mode/m.test(header) ? 'added' : /^deleted file mode/m.test(header) ? 'removed' : rename ? 'renamed' : 'modified',
      additions,
      deletions,
      patch,
    });
  }
  return files;
}

export async function worktreeDiff(ws: Workspace, path: string, mode: DiffMode): Promise<WorktreeDiff> {
  const wt = ws.worktrees.find((t) => t.path === path);
  if (!wt) throw new Error("that folder isn't one of the workspace's worktrees");
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', '--unified=3'];
  const untracked = (await git(path, ['ls-files', '--others', '--exclude-standard']).catch(() => '')).split('\n').filter(Boolean).slice(0, 50);
  const out = (label: string, raw: string, note: string | null = null): WorktreeDiff => {
    const files = parseGitDiff(raw);
    return { mode, label, files, untracked, note: files.length ? null : note };
  };

  if (mode === 'staged') {
    if (!(await resolves(path, 'HEAD'))) return out('staged changes', await git(path, ['diff', '--cached', ...flags, '--root']));
    return out('staged changes vs HEAD', await git(path, ['diff', '--cached', ...flags, 'HEAD']), 'Nothing is staged.');
  }

  if (mode === 'commit') {
    if (!(await resolves(path, 'HEAD'))) return out('last commit', '', 'No commits yet.');
    const subject = (await git(path, ['log', '-1', '--format=%h %s'])).trim();
    if (await resolves(path, 'HEAD~1')) return out(`last commit (${subject}) vs its parent`, await git(path, ['diff', ...flags, 'HEAD~1', 'HEAD']));
    // First commit: compare against the empty tree.
    const empty = (await git(path, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
    return out(`first commit (${subject})`, await git(path, ['diff', ...flags, empty, 'HEAD']));
  }

  const base = await baseRef(path, wt.baseBranch);
  if (!base) return out('base branch', '', "Couldn't find the base branch (none recorded, and no origin/HEAD, main or master).");
  const mergeBase = (await git(path, ['merge-base', base, 'HEAD']).catch(() => '')).trim();
  if (!mergeBase) return out(`vs ${base}`, '', `No common ancestor with ${base}.`);
  // The working tree against the merge base: everything this branch has done, committed or not.
  return out(
    `working tree vs ${base} (merge base ${mergeBase.slice(0, 7)})`,
    await git(path, ['diff', ...flags, mergeBase]),
    `No changes compared with ${base}.`,
  );
}
