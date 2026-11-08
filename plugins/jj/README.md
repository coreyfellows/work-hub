# jj (experimental)

A source-control provider for [Jujutsu](https://jj-vcs.github.io/jj/): a workspace's working copies can be jj
workspaces instead of git worktrees. Pick "Jujutsu (jj)" under Settings → Source control or in the New workspace form,
and the setup session and workspace rules tell Claude how to make and record one.

**Experimental.** Off by default, and tested only against a fake `jj` (a script that records its arguments and prints
canned output); it has never run against a real jj repo. Fix and commit back whatever doesn't hold up.

No routes, slots or web half: it only registers a provider with `ctx.vcs.register` (`provider.ts`).

## What it runs

Every command goes through `ctx.exec.run` (no shell). `<root>` is the working copy's folder.

| what | command |
| --- | --- |
| detect | `jj root` in the folder (no match when it fails) |
| identity | `jj -R <root> --ignore-working-copy git remote list`: `owner/name` of `origin`, else none |
| line | the nearest local bookmark on `@`'s ancestry, `jj -R <root> --ignore-working-copy log -r 'latest(::@ & bookmarks())' --no-graph -T local_bookmarks` (the first, without `*`/`??`), so it survives `jj commit` / `jj new`; else the change id from `jj -R <root> --ignore-working-copy log -r @ --no-graph -T 'change_id.short()'`; the head is the change id |
| shared lines | `main`, `master`, `trunk` (never tie a session to a workspace by these alone) |
| inspect | dirty = non-empty `jj -R <root> diff --summary` (the only call that snapshots the working copy) |
| remove | refuses a dirty workspace unless forced, then `jj -R <root> workspace forget` and deletes the folder (`fs.rm`, only `<root>`) |
| prereq | `jj --version` |

What Claude is told to run to make one (paths are single-quoted in the prompt; a ticket's key as `<name>` when it looks like one, `ABC-123`, else a short kebab-case name for the task):

```
jj -R <source> workspace add <worktrees>/<repo>/<name> --name <workspace id> -r '<base>'    # base: trunk() by default
jj -R <worktrees>/<repo>/<name> bookmark create <name> -r @
wh trust <worktrees>/<repo>/<name>
wh worktree add <workspace id> --path <worktrees>/<repo>/<name> --vcs jj --branch <name> --base '<base>'
```

## Settings

None.

## Caveats

- The repo's own workspace (its `.jj/repo` is the store, a directory) is never removed, forced or not; only secondary
  workspaces (`.jj/repo` is a file) are. The core also never removes a copy outside the worktrees folder.
- `workspace forget` is run without a name: it forgets the workspace `-R` points at. jj keeps the workspace's name in
  its binary working-copy state, so the provider can't read it back to pass it.
- "Dirty" is jj's working-copy commit having changes. Forgetting a workspace doesn't lose that commit (it stays in the
  repo), but removal still refuses it unless forced, like git's uncommitted changes. Nothing counts as unsaved.
- A colocated jj + git repo is detected as git (git is asked first).
- No Diff tab or PR links: those are git-only.
