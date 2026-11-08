# Source-control providers and plain-folder workspaces: design

Date: 2026-11-08. Status: draft for approval (builder check done; the owner's answers folded in).

## Intent

work-hub assumes every workspace is git: its working copies are git worktrees with an `owner/name` repo and a branch,
sessions are matched to workspaces by git toplevel and branch, and the prompts tell Claude to run `git worktree add`.
That locks out two kinds of people the public fork should welcome (the owner's words: "general openness"):

1. people whose code lives in another source control system: **Jujutsu (jj), Mercurial (hg), Perforce (p4)**;
2. people (or the same people) who want a workspace for work that isn't a repo at all: **a plain folder on their
   drive**, existing or new, with Claude sessions running in it.

The fix is a **source-control provider** interface. git becomes one provider (its behaviour unchanged), plus jj, hg,
p4 and a built-in "plain folder" provider, and others can add more as plugins. This is built in work-hub `main` (it
isn't specific to anyone) and reaches the public fork with the next `export-oss.sh`.

## Goals

- A provider plugin interface covering what work-hub does with a working copy (below), registered by plugins the way
  sources and enrichers are. Additive to plugin API 1: no `apiVersion` bump.
- git implemented as a provider by moving today's code behind the interface.
- A built-in **folder** provider: a workspace can be "just a directory". New workspace lets you pick an existing folder
  or type a new path, which work-hub creates.
- **jj, hg and p4 providers, isolation first** (the owner's priority): each workspace gets its own working copy
  (`jj workspace add`, `hg share`, a new p4 client) so parallel sessions don't trample each other. Seeing what changed
  (Diff tab, recent changes, edit cards) in those systems comes second.
- **Detected, overridable:** work-hub detects a folder's source control (`.jj`, `.hg`, `.git`, a p4 client root).
  Settings has a default for new workspaces, and New workspace can override it per workspace.

## Hard rule (the owner's anti-goal)

**The owner's git and GitHub workflow must not change at all.** Worktrees, branch and base labels, PR chips and PR
linking, git cards, the Diff tab, reconcile adopting sessions and following branch renames, the explorer and workspace
prompts, `wh worktree add`: all must behave and read exactly as today, with no new prompts, settings to fill in, or
visible labels changed for a git-only setup. Treat any diff in git-path behaviour or prompt text as a bug. The existing
test suite stays green untouched; add equivalence tests where code moves (e.g. the git provider's prompt text equals
today's strings byte for byte).

## Non-goals

- PR or review features for non-git systems (Phabricator, Swarm, hg servers…). The github, git-cards, scrutinize-pr and
  plugin-author plugins stay git/GitHub-only and simply don't appear for other workspaces.
- Converting existing workspaces between systems.
- Windows-specific work beyond what the providers' CLIs already give.
- Fixing the two git bugs the survey found (a local repo with no `origin` is never auto-recorded by reconcile; a plain
  folder under the worktrees root can't be removed). They're follow-ups, because fixing the first changes git
  behaviour; list them in the plan's "later" section.

## What the survey found (context for the builder)

A read-only survey of `main` (2026-11-08) found git assumptions in:

- **Store** (`server/store/db.ts`, `workspaces.ts`): `worktrees.repo` is `NOT NULL` ("owner/name"), `branch`,
  `base_branch`; `findWorkspaceByWorktree` matches path, then repo + branch. No provider/kind column.
- **Session discovery and reconcile** (`server/lib/git.ts`, `server/sources/claude.ts`, `server/reconcile.ts`,
  `server/lib/sessionWorktrees.ts`, `server/lib/worktreeCleanup.ts`, `server/worktreeRoutes.ts`): `branchInfo`,
  `baseRef`, `worktreesByBranch`, `rev-parse --show-toplevel`, `SHARED_BRANCHES`, a regex over Bash commands for
  `git worktree add`, the `<root>/<repo>/<name>` layout, dirty/unpushed/linked checks and `worktree remove`.
  Sessions whose `repo` is null are skipped by reconcile.
- **CLI** (`scripts/wh.ts`): `wh worktree add` detects repo and branch with git.
- **Prompts** (`plugins/workspace-setup/dispatch.ts`, `server/workspaceSessions.ts`, `plugins/ticket-workflow`):
  `git fetch` / `git worktree add … -b <branch> origin/<base>`, branch pattern `f-<KEY>-…`.
- **Plugins**: worktree-diff (merge-base diffs), bash-snapshots (git tree snapshots), session-awareness (`git log
  base..HEAD`), github (`ensureBranchWorktree`, PR ↔ branch), adversarial-review, scrutinize-pr, git-cards,
  plugin-author. Display-only uses of `repo @branch` in terminals, code, session-tools, notes.
- **Web**: `WorktreeList.tsx` (`repo @branch → base`, "the branch stays"), `WorkspacePage.tsx` Worktrees block,
  `SetupGate.tsx` (folders).
- `ctx.git` and the plugin-api exports `baseRef`, `branchInfo`, `parseRepo`, `worktreesByBranch` are the natural seam.

## The provider interface

Name: `SourceControlProvider` (types in `plugin-api/server.ts`). Registered with `ctx.vcs.register(provider)`; the core
exposes `ctx.vcs.detect(path)`, `ctx.vcs.get(id)`, `ctx.vcs.list()` and a helper to resolve the provider of a recorded
working copy. Unregistered on plugin failure like other hooks. `ctx.git` and its exports stay as they are.

Required members (isolation and identity, what every feature needs):

| member | what | git (today's code) |
| --- | --- | --- |
| `id`, `title` | `git`, `jj`, `hg`, `p4`, `folder` | |
| `detect(path)` | is `path` inside a working copy of mine; its root | `rev-parse --show-toplevel` |
| `identity(root)` | a repo id for display/matching (may be null) and an optional `owner/name` remote | `branchInfo` repo, `parseRepo` |
| `line(root)` | the current line of work: branch / bookmark / changelist, and a head id | `branch --show-current` |
| `sharedLines` | lines never used to match sessions by name | `SHARED_BRANCHES` |
| `createWorkingCopy({ source, path, line, base })` | an isolated working copy for a workspace (called by `wh`, below) | `fetch` + `worktree add` (not wired to `wh` for git: its flow stays as is) |
| `inspect(root)` | disposable? dirty? unpushed/unsubmitted work? | `worktreeCleanup.ts` |
| `removeWorkingCopy(root)` | remove it, keeping the line | `worktree remove` |
| `agentInstructions(ctx)` | the prompt text telling Claude how to make a working copy for a workspace | today's strings, verbatim |
| `createCommandMatcher` | recognise a create command in a Bash call (reconcile from transcripts) | today's regex |
| `prereq()` | is the CLI installed (Status page / setup) | `git --version` |

**Who creates working copies (my call):** the Claude session does, as for git today: the explorer (or a workspace
session) picks the source and runs the command its instructions give, then records it. git keeps today's instructions
(`git worktree add` + `wh worktree add`) verbatim. Every other provider's `agentInstructions` point at one new command,
`wh copy add <ws> --vcs <id> --source <path or template> --path <dest> [--line <name>] [--base <rev>]`, which calls the
provider's `createWorkingCopy` and records the result, so agents don't need each CLI's syntax. For p4 the "source" is a
template client chosen from the p4 plugin's settings (a list of name → template client), not a clone.

Optional members (seeing what changed; the second priority): `baseOf(root)`, `diff(root, { against: 'base' | 'last' |
'pending' })` returning unified diff text (so `parseDiff` keeps working), `untracked(root)`, `recentChanges(root, n)`,
`hasChanges(root)`, `snapshot(root)` / `diffSnapshots(a, b)`, `readOnlyCommands` (the reviewer allowlist). A feature
that needs a missing optional member hides itself for that working copy instead of erroring.

## Data model

One core migration (a table rebuild, since SQLite can't drop `NOT NULL`):

- `worktrees.repo` becomes nullable (a plain folder has none);
- new `worktrees.vcs TEXT NOT NULL DEFAULT 'git'`: existing rows are git, so nothing changes for them;
- `branch` / `base_branch` keep their names and hold the provider's "line" and "base" (bookmark, changelist…).

A second column, `workspaces.vcs TEXT` (nullable; null = "detect"), keeps the choice made in New workspace before any
working copy exists (my call). A workspace may mix providers (say a git worktree and a plain folder): features decide
per working copy (the Diff tab and PR chips appear only for git ones; a provider without an optional member hides that
feature for its copies). `workspaceRules()` includes the instructions of the workspace's chosen provider plus those of
every provider among its recorded copies; with no choice and only git copies (or none) it's exactly today's text.

`Worktree` gains `vcs`. `findWorkspaceByWorktree` matches path first (all providers), then repo + line only for
providers with an identity and only outside `sharedLines`. The store API and `wh` keep the word "worktree" internally;
renaming is out of scope.

## Detection and choice

- `ctx.vcs.detect(path)` asks providers in a fixed order: **git before jj when both `.git` and `.jj` exist (a
  colocated jj repo)**, unless Settings' default is jj; then hg, p4; `folder` matches anything as the fallback.
- **Settings → Source control** (new core group): "Default for new workspaces": Detect (default), or a provider.
  Each non-git provider's own settings live with its plugin (e.g. p4's template client).
- **New workspace**: a new collapsed **More options** section (the form has none today: only Ticket/Prompt and
  Start) with "Source control" (Detect / the active providers / Plain folder) and "Folder". The owner agreed new
  optional controls may be visible to git users as long as nothing existing changes and nothing needs filling in.
- **Under Detect, the explorer gets git's text only** (my call, from the hard rule): installing `jj` must not change a
  git user's prompts. Non-git instructions appear only when the workspace's choice, the Settings default, or a recorded
  copy is non-git.
- **Provider plugins (jj, hg, p4) are off by default** (`defaultEnabled: false`); you switch them on in Settings →
  Plugins. The folder provider is always available.
- **Fragment context:** `workspace-rules` fragments get the workspace's kinds (additive to `PromptContext`), so the
  ticket-workflow fragment (git conventions: `<root>/<repo>/<KEY>`, `f-<KEY>-…`) is left out when none of its kinds is
  git.

## Plain-folder workspaces

- New workspace's **Folder** field takes a typed path (browsers can't hand over real paths, and there is no
  server-side directory browser: the owner's choice). An absolute path may be anywhere on the drive; a bare name lands
  under a new **Settings → Folders → "Plain workspaces"** root (default `~/workspaces`). work-hub creates the folder if
  missing, records it (`vcs = 'folder'`, `repo` null) and starts sessions there.
- **Trust (security):** `trustWorktree` today only accepts paths under the worktrees root. It additionally accepts the
  Plain workspaces root, and any other folder only after the user confirms it in the UI ("Let Claude sessions work in
  ~/Documents/foo?", a `ConfirmPopover`); confirmed folders are stored (core table or `ui_prefs`, builder's call) and
  `wh trust` refuses folders that aren't. Always refused: `/`, the home folder itself, and system folders. The route
  that confirms is a JSON write behind the existing guard (CSRF rules apply). The explorer is skipped or given a short folder-specific prompt (builder's call).
- **Removing a plain folder from a workspace never deletes files**: it only forgets the record. (My call.)
- Diff tab, PR chips, branch/base labels, git cards and session-awareness's commits don't appear for it.
- `wh` gains a way to record one (e.g. `wh worktree add <ws> --path <dir> --vcs folder`, or detected).

## Reconcile

Non-git working copies are matched by **path only** (deepest recorded path containing the session's cwd), never by
repo + line, and no provider CLI runs in the session-polling path for them (my call: p4 commands hit a server). Session
discovery keeps calling git's `branchInfo` exactly as today. `createCommandMatcher` is only needed for git (today's
regex); `wh copy add` records non-git copies itself.

## Providers

All non-git providers are plugins in `plugins/<id>/`, off by default, each labelled **experimental** in its README and
Settings. **They are tested with fake CLIs only** (the owner's choice: nothing gets installed for this), so
"experimental" stays until someone verifies them against real repos.

- **jj**: create = `jj workspace add <path> --name <ws> -r <base>` (plus a bookmark for the line when the workspace has
  a ticket); line = the working copy's bookmark, else its change id; remove = `jj workspace forget` then delete the
  directory (confirmed in the UI); dirty = non-empty `jj diff --summary`. Diffs later (jj makes snapshots trivial).
- **hg**: create = `hg share <source> <path>` then `hg update <base>` and `hg bookmark <line>`; line = active bookmark,
  else branch; remove = delete the share (confirmed); dirty = `hg status`.
- **p4** (hardest; ship last): create = a new client spec copied from a **template client** (plugin setting, per
  depot/stream) with `Root` set to the new folder, then `p4 sync`; line = the client's stream, plus the default/pending
  changelist; remove = refuse while files are opened or shelved, else `p4 client -d` and delete the folder (confirmed);
  dirty = `p4 opened`. Uses the user's existing `p4` login (`P4PORT`, `P4USER`, tickets); never stores credentials.
- **git** and **folder** live in the core (core can't import plugins, and `workspaceRules()` is core).
- **folder**: detect = always, identity/line = none, create = `mkdir -p`,
  remove = forget only.

## Prompts

`workspaceRules()` and the workspace-setup explorer prompt ask the workspace's provider (or the default) for
`agentInstructions`. git returns today's text unchanged (tested byte for byte). ticket-workflow's worktree conventions
are git conventions and stay; other providers bring their own wording.

## Shipping order (my call; the owner didn't ask for one)

1. Interface + git provider (code moved, behaviour identical) + the schema migration.
2. Folder provider + New workspace "Folder" + Settings → Folders root + Settings → Source control.
3. jj. 4. hg. 5. p4. Each provider: isolation first; its optional diff members after.

Each step is mergeable on its own and keeps the full suite green.

## Constraints

- work-hub's CLAUDE.md rules all apply: plugins import only `plugin-api`; core never imports plugins; additive plugin
  API with a CHANGELOG "Additions" entry; low-data rules (new routes revalidate; nothing polls more); mobile at 375px;
  `ConfirmPopover` for deleting a working copy; scripts dry run by default.
- Destructive provider operations (delete a working copy's folder, delete a p4 client) always go through the UI's
  confirm and refuse when there's unsaved/unsubmitted work, like git's dirty/unpushed checks today.
- Tests: existing suite untouched and green. Providers get unit tests against fake `jj` / `hg` / `p4` CLIs (scripts
  that record calls and print canned output), in the style of `scripts/launchd.test.ts`. No real-binary tests.
- `repo` becoming nullable touches display code that does `repo.split('/')` (e.g. `web/src/panels/WorktreeList.tsx`);
  handle null everywhere `repo` is read.

## Decisions

The owner's: general openness as the why; jj, hg, p4 plus a plugin interface; detected with an override; plain folders
either existing or new; isolation before diffs; the hard rule; any typed path with a confirm; new optional controls may
be visible; fake-CLI tests only, experimental labels.

My calls (check these): agent-driven creation with `wh copy add`; `workspaces.vcs`; mixed workspaces, features per copy;
git-only text under Detect; provider plugins off by default; path-only reconcile for non-git; removing a plain folder
never deletes files; the shipping order.

## Left to the builder

- Exact TypeScript shapes, file layout, and whether `folder` lives in core or `builtin/`.
- How the explorer behaves for a plain-folder workspace.
- The enable rule for provider plugins (default on vs. on when the CLI exists).
- How the Diff tab and session-awareness pick up the optional members once a provider has them.
- UI wording for non-git working copies (as long as git-only workspaces read exactly as today).
