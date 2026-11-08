# hg (experimental)

A source-control provider for [Mercurial](https://www.mercurial-scm.org/): a workspace's working copies can be hg
shares (`hg share -B`, bookmarks shared with the source) of the repo's own clone instead of git worktrees. Pick "Mercurial (hg)" under Settings → Source
control or in the New workspace form, and the setup session and workspace rules tell Claude how to make and record one.

**Experimental.** Off by default, and tested only against a fake `hg` (a script that records its arguments and prints
canned output); it has never run against a real hg repo. Fix and commit back whatever doesn't hold up.

No routes, slots or web half: it only registers a provider with `ctx.vcs.register` (`provider.ts`).

## What it runs

Every command goes through `ctx.exec.run` (no shell). `<root>` is the working copy's folder.

| what | command |
| --- | --- |
| detect | `hg root` in the folder (no match when it fails) |
| identity | `hg -R <root> paths default`: its `owner/name`, else none |
| line | `hg -R <root> log -r . -T '{activebookmark}'`, else `hg -R <root> branch`; the head is `hg -R <root> log -r . -T '{node\|short}'` |
| shared lines | `default` (never ties a session to a workspace by itself) |
| inspect | dirty = non-empty `hg -R <root> status` |
| remove | refuses a dirty share unless forced, then deletes the share's folder (`fs.rm`, only `<root>`) |
| prereq | `hg --version` |

What Claude is told to run to make one (paths are single-quoted in the prompt; a ticket's key as `<name>` when it looks like one, `ABC-123`, else a short kebab-case name for the task):

```
hg share -B <source> <worktrees>/<repo>/<name>
hg -R <worktrees>/<repo>/<name> update <base>      # base: default unless the work builds on another branch or bookmark
hg -R <worktrees>/<repo>/<name> bookmark <name>
wh trust <worktrees>/<repo>/<name>
wh worktree add <workspace id> --path <worktrees>/<repo>/<name> --vcs hg --branch <name> --base <base>
```

## Settings

None.

## Caveats

- Only a share (a folder with `.hg/sharedpath`) is ever removed; a repo's own clone is refused, forced or not. The core
  also never removes a copy outside the worktrees folder.
- A share's commits live in the source repo's store, so deleting the share loses only uncommitted changes (refused
  unless forced; `hg status` counts untracked files too). Nothing counts as unsaved.
- Shares are made with `-B`, so bookmarks are shared with the source clone: a bookmark made in the share (the line)
  shows in the source and every other share of it, and moving it anywhere moves it everywhere.
- No Diff tab or PR links: those are git-only.
