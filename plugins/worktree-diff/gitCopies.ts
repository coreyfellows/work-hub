/**
 * The Diff tab is git's. It shows when the workspace has a git copy, or has no copies yet and is git (or not chosen):
 * a git workspace still setting up keeps its tab. It's hidden for a workspace of another kind (folder, jj…) without a
 * git copy, and for one whose copies are all of another kind.
 */
export const hasGitCopy = (ws: { vcs?: string | null; worktrees: Array<{ vcs: string }> }): boolean =>
  ws.worktrees.some((t) => t.vcs === 'git') || (ws.worktrees.length === 0 && (!ws.vcs || ws.vcs === 'git'));
