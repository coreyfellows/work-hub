# worktree-diff

The Diff tab on a workspace: one of its recorded worktrees compared with its base branch, the last commit, or what's staged.
On by default.

## Server (`server.ts`, `worktreeDiff.ts`)

- `GET /api/workspaces/:id/diff?path=<worktree>&mode=base|commit|staged`. `path` must be one of the workspace's recorded
  worktrees; git runs via `execFile`, read-only. `base` = working tree vs the merge base with the worktree's base branch
  (recorded one, `origin/` first, else origin/HEAD, main, master), so committed and uncommitted work together; `commit` = the
  last commit vs its parent (empty tree for a first commit); `staged` = index vs HEAD. Untracked files aren't in any diff, so
  they're only counted.
- `GET /api/workspaces/:id/pr-changes`: for each recorded worktree (by id), whether a PR from its branch would have changes
  (the branch's diff against its merge base with the base branch isn't empty). `null` = git can't tell. Cached 20s per
  worktree. The workspace's worktree "Create PR" button uses it: no "Create PR" when the branch has no diff vs its merge
  base; unknown shows the button. Polled every 30s, only on open/worktree change in Low data.
- Both routes are ETag-revalidated (`ctx.revalidate`).
- Service `worktree-diff`: `{ branchHasChanges(worktree) }`, for other plugins that want the same answer in-process.
- `baseRef` (resolving a worktree's base branch) lives in the core (`server/lib/git.ts`, also used by adversarial review)
  and reaches the plugin through `plugin-api/server.ts`.

## Web (`web.tsx`, `WorktreeDiff.tsx`, `styles.css`)

- `workspace-panel` `diff` (label "Diff", order 5 so it stays ahead of Note and Code). Renders with the shared `DiffTable`
  (`plugin-api/web.ts`); re-polls every 15s while the tab is showing (not in Low data, which shows `<AsOf>` instead); the
  chosen mode is remembered in localStorage (`wh.diffMode`).

## Settings

None.
