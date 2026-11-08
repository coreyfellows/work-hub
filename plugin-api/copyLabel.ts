/** The parts of a working copy a label is made from (the `Worktree` record has them all). */
export interface CopyLike {
  vcs: string;
  repo: string | null;
  path: string;
  branch: string | null;
}

/**
 * How a workspace's working copy reads in lists and pickers: a bold `name` and a muted `detail`. A git copy is its
 * repo's name and `@branch`; any other copy is its folder's name, and `<vcs> <branch>` (a plain folder has no detail).
 * A record with no vcs is read as git. Pure, so web and server code share it; a missing repo or branch never throws.
 */
export function copyLabel(t: CopyLike): { name: string; detail: string | null } {
  if (!t.vcs || t.vcs === 'git') {
    const repo = t.repo ?? '';
    return { name: repo ? (repo.split('/')[1] ?? repo) : '', detail: `@${t.branch ?? '?'}` };
  }
  const name = t.path.split('/').filter(Boolean).pop() ?? t.path;
  return { name, detail: t.vcs === 'folder' ? null : `${t.vcs} ${t.branch ?? ''}` };
}

/** `copyLabel` on one line, for menus and `<option>`s: "repo @branch", "folder-name", "jj-copy jj main". */
export function copyLabelText(t: CopyLike): string {
  const l = copyLabel(t);
  return [l.name, l.detail].filter(Boolean).join(' ');
}
