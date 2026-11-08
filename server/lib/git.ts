import { run } from './exec.ts';

export interface BranchInfo {
  branch: string | null;
  /** owner/name parsed from the origin remote */
  repo: string | null;
}

const cache = new Map<string, { at: number; info: BranchInfo }>();
const TTL_MS = 30_000;

export function parseRepo(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

/** Current branch and origin repo of a directory, cached briefly since sessions poll every few seconds. */
export async function branchInfo(cwd: string): Promise<BranchInfo> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  let failed = false;
  const fail = () => {
    failed = true;
    return null;
  };
  const [branch, remote] = await Promise.all([
    run('git', ['-C', cwd, 'branch', '--show-current'], { timeoutMs: 10_000 }).then((s) => s.trim() || null, fail),
    // No origin is a real answer (local-only repo), not a failure.
    run('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 }).then(parseRepo, () => null),
  ]);
  const info = { branch, repo: remote };
  // Don't cache a failed lookup (e.g. a timeout under load): it would hide the branch for the whole TTL.
  if (!failed) cache.set(cwd, { at: Date.now(), info });
  else if (hit) return hit.info;
  return info;
}

/** Map of branch -> worktree path for a repo checkout. */
export async function worktreesByBranch(repoDir: string): Promise<Map<string, string>> {
  const out = await run('git', ['-C', repoDir, 'worktree', 'list', '--porcelain']);
  const map = new Map<string, string>();
  let path: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line.startsWith('branch refs/heads/') && path) map.set(line.slice(18), path);
  }
  return map;
}

const gitIn = (cwd: string, args: string[]) => run('git', ['-C', cwd, ...args], { timeoutMs: 20_000 });

async function resolves(cwd: string, ref: string): Promise<boolean> {
  if (!ref || ref.startsWith('-')) return false;
  return gitIn(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(() => true, () => false);
}

/** The worktree's base branch as a ref git can resolve: the recorded one (remote first), else origin's default, else main/master. */
export async function baseRef(cwd: string, recorded: string | null): Promise<string | null> {
  const names = [recorded, await gitIn(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).then((s) => s.trim().replace(/^origin\//, ''), () => null), 'main', 'master'];
  for (const n of names) {
    if (!n) continue;
    const bare = n.replace(/^origin\//, '');
    for (const ref of [`origin/${bare}`, bare]) if (await resolves(cwd, ref)) return ref;
  }
  return null;
}
