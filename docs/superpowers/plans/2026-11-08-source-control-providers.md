# Source-control providers and plain-folder workspaces: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** git becomes one source-control provider behind an interface; add a plain-folder provider with New workspace
support, then experimental jj, hg and p4 provider plugins (isolation first).

**Architecture:** a provider registry in the core (`server/lib/vcs/`), with `git` and `folder` built in and exposed to
plugins as `ctx.vcs`. Stored working copies gain a `vcs` column (`'git'` for every existing row), workspaces a nullable
`vcs` choice. Every git code path stays as it is; non-git kinds branch off beside it.

**Tech Stack:** Node 26 TypeScript (type stripping), Hono, `node:sqlite`, React, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-08-source-control-providers-design.md`

## Global Constraints

- Hard rule: a git-only setup behaves and reads exactly as before. Existing tests stay green untouched; prompt text for
  git is byte-identical (tested).
- Plugin API stays version 1; every addition gets a line under CHANGELOG.md "Additions" dated 2026-11-08.
- Plugins import only `plugin-api/*`; core never imports `plugins/` (`server/plugins/boundary.test.ts`).
- New core routes go in `CORE_ROUTES` (`server/coreRoutes.ts`); JSON writes via `readJson`; polled GETs revalidate.
- Destructive UI actions use `ConfirmPopover`; mobile at 375px never scrolls sideways.
- jj, hg, p4 plugins: `defaultEnabled: false`, README and Settings say **experimental**, tested with fake CLIs only.
- Removing a plain folder from a workspace never deletes files.
- Trust never accepts `/`, the home folder itself, or system folders (`/System`, `/usr`, `/bin`, `/sbin`, `/etc`,
  `/Library`, `/Applications`, `/private`, `/var`, `/opt`).
- Run `pnpm typecheck` and `pnpm test` before each commit.

## Review Focus

- A typed folder path with `~`, a trailing slash, or a symlink: resolved with `expandFolder` + `realpath`, recorded once.
- A typed path that exists as a file: New workspace says so and creates nothing.
- A workspace mixing a git worktree and a plain folder: Diff tab and PR chips appear for the git one only; rules list both.
- An old database (user_version 16) with worktrees and sessions: migrates with every row `vcs = 'git'` and nothing lost.
- A provider plugin that throws in `register`: its provider is unregistered and git keeps working.

(Each has a test in the owning task below.)

---

### Task 1: Schema and store

**Files:** Modify `server/store/db.ts` (MIGRATIONS 17, 18), `server/store/workspaces.ts`; Test `server/store/vcsSchema.test.ts`.

**Interfaces:**
- Produces: `Worktree { id; vcs: string; repo: string | null; path; branch; baseBranch }`; `Workspace.vcs: string | null`;
  `addWorktree(ws, { repo?: string | null; path; branch?; baseBranch?; vcs?: string })` (vcs default `'git'`);
  `createWorkspace(input & { vcs?: string | null })`; `setWorkspaceVcs(id, vcs: string | null)`;
  `allWorktrees(): Array<{ workspaceId; vcs; repo: string | null; path; branch }>`;
  `findWorkspaceByWorktree` matches repo + branch only among `vcs = 'git'` rows; table `trusted_folders(path TEXT PRIMARY KEY, created_at)`
  with `trustFolder(path)`, `isTrustedFolder(path): boolean`.

- [ ] **Step 1: Failing tests** in `vcsSchema.test.ts` against an in-memory DB built with `migrate()` at version 16
  then 18: an existing worktree row comes back with `vcs === 'git'` and its repo/branch; `addWorktree(ws, { path: '/f', vcs: 'folder' })`
  stores `repo === null`; a `jj` row with repo `o/r` branch `x` is not found by `findWorkspaceByWorktree({ repo: 'o/r', branch: 'x' })`
  while a git row is; `createWorkspace({ …, vcs: 'jj' })` hydrates `vcs: 'jj'`, default `null`; `trustFolder('/a')` then `isTrustedFolder('/a')`.
- [ ] **Step 2:** Run `node --test server/store/vcsSchema.test.ts`; expect failures.
- [ ] **Step 3:** Migration 17 rebuilds `worktrees` (same columns, `repo TEXT` nullable, plus `vcs TEXT NOT NULL DEFAULT 'git'`;
  copy rows; drop; rename; recreate the `path` UNIQUE). Migration 18: `ALTER TABLE workspaces ADD COLUMN vcs TEXT;` and
  `CREATE TABLE trusted_folders`. Update the store functions and types above. Every reader of `repo` in the core
  (`workspaceSessions.ts`, `reconcile.ts` `WorktreeRec`, `worktreeRoutes.ts` `WorktreeInfo`) takes `string | null`.
- [ ] **Step 4:** Run the new test and the full `pnpm test`; all pass.
- [ ] **Step 5:** Commit "Store: worktrees.vcs, nullable repo, workspaces.vcs, trusted folders".

### Task 2: Provider interface, registry, git and folder providers, `ctx.vcs`

**Files:** Create `server/lib/vcs/types.ts`, `server/lib/vcs/registry.ts`, `server/lib/vcs/git.ts`, `server/lib/vcs/folder.ts`,
`server/lib/vcs/registry.test.ts`; Modify `server/plugins/context.ts` (+ takeback on failure), `plugin-api/server.ts`, `CHANGELOG.md`.

**Interfaces:**
- Produces (types.ts):
  ```ts
  interface WorkingCopyState { exists: boolean; dirty: boolean; unsaved: number; removable: boolean; block: string | null }
  interface AgentInstructionOpts { workspaceId: string; ticketKey: string | null; whCommand: string; worktreesDir: string }
  interface SourceControlProvider {
    id: string; title: string; experimental?: boolean;
    detect(path: string): Promise<string | null>;              // working-copy root, or null
    identity(root: string): Promise<{ repo: string | null }>;
    line(root: string): Promise<{ line: string | null; head: string | null }>;
    sharedLines: ReadonlySet<string>;
    inspect(root: string): Promise<WorkingCopyState>;
    removeWorkingCopy(root: string, opts: { force: boolean }): Promise<void>;
    agentInstructions(o: AgentInstructionOpts): string[];      // prompt lines
    prereq(): Promise<{ ok: boolean; detail: string }>;
  }
  ```
- Produces (registry.ts): `registerProvider(p, owner = 'core')`, `removeProviders(owner)`, `getProvider(id)`, `listProviders()`,
  `detectProvider(path, { prefer?: string | null }): Promise<{ provider; root } | null>` (order: git before jj when both
  match unless `prefer === 'jj'`; then hg, p4, others; `folder` last, always matching with root = path).
- `ctx.vcs = { register(p), get(id), list(), detect(path, opts?) }`; types exported from `plugin-api/server.ts`.
- git provider: `detect` = cached `rev-parse --show-toplevel`; `identity` = `branchInfo().repo`; `line` = `branchInfo().branch`;
  `sharedLines` = today's `SHARED_BRANCHES` (move the set to `server/lib/vcs/git.ts` and import it in reconcile);
  `inspect`/`removeWorkingCopy` wrap `inspectWorktree`/`removalBlock`/`removeWorktreeFolder`; `agentInstructions` = `[]`
  (git's text stays where it is today).
- folder provider: `detect(p)` = p; identity/line null; `inspect` = `{ exists, dirty: false, unsaved: 0, removable: true, block: null }`; `removeWorkingCopy` = no-op (record only);
  `agentInstructions` = one line: "This workspace's folder is a plain directory (no version control): work in it directly; record another folder with `<wh> worktree add <ws> --path <dir> --vcs folder`."

- [ ] **Step 1: Failing tests** (`registry.test.ts`): registering `{ id: 'jj', detect: () => '/r' }` beside a fake git that also
  matches → `detectProvider('/r/x')` returns git, with `prefer: 'jj'` returns jj; folder matches when nothing else does;
  `removeProviders('plug')` drops only that owner's; a plugin whose `register()` throws after `ctx.vcs.register` leaves
  no provider behind (loader takeback, test in `server/plugins/loaderLimits.test.ts` style).
- [ ] **Step 2:** Run; expect failures. **Step 3:** Implement. **Step 4:** `pnpm typecheck && pnpm test` pass.
- [ ] **Step 5:** CHANGELOG addition line; commit "Source-control provider interface; git and folder providers".

### Task 3: Core consumers go through providers (git text unchanged)

**Files:** Modify `server/reconcile.ts`, `server/worktreeRoutes.ts`, `server/workspaceSessions.ts`, `server/lib/prompts.ts`;
Tests `server/workspaceSessions.test.ts`, `server/reconcile.test.ts`, `server/worktreeRoutes.test.ts` (new if absent).

**Interfaces:** Consumes Task 1–2. Produces `PromptContext.kinds?: string[]` (the workspace's chosen vcs plus its copies' vcs,
deduped; `['git']` when none) passed to `workspace-rules` and `session-context` fragments.

- [ ] **Step 1: Failing tests:** `workspaceRules('ws')` for a workspace with only git copies equals a snapshot of today's
  array (copy the current strings into the test); with a folder copy it ends with the folder provider's line; `contextPrompt`
  shows a folder copy as `  - /p (folder)` and a git one exactly as today; `ownerByCwd` never matches a non-git record by
  repo + branch; removing a folder record via `POST /api/workspaces/:id/worktrees/remove` leaves the directory on disk.
- [ ] **Step 2:** Run; fail. **Step 3:** Implement: rules append each non-git kind's `agentInstructions`; `worktreeRoutes`
  uses `getProvider(w.vcs)` for non-git rows (git rows keep the current code path); `WorktreeInfo` gains `vcs`.
- [ ] **Step 4:** Full suite passes. **Step 5:** Commit.

### Task 4: Trust, Settings (folders root, default source control)

**Files:** Modify `server/lib/sessions.ts` (`trustWorktree`), `server/lib/folders.ts` (`plainDir`), `server/config.ts`
(`paths.plain`), `server/index.ts` (settings group `vcs`, route), `server/coreRoutes.ts`; Tests `server/lib/sessions.test.ts`, `server/lib/folders.test.ts`.

**Interfaces:** `trustWorktree(path, { configFile?, worktreesRoot?, plainRoot?, isTrusted? })` accepts paths under either
root or `isTrustedFolder(realpath)`; refuses the paths in Global Constraints. `folderTrustError(path, home): string | null`.
`POST /api/trusted-folders { path }` → `{ path }` (validates with `folderTrustError`, then `trustFolder`). Setting keys:
`folders.plainDir` (default `<home>/workspaces`, env `WORK_HUB_PLAIN_DIR`), group `vcs` key `default` (select:
`detect` + registered providers' ids + `folder`; default `detect`), read via `config.vcsDefault`.

- [ ] **Step 1: Failing tests:** trust of `<plain>/x` passes; `/tmp/elsewhere` (realpath) refused until `isTrusted` says yes;
  `folderTrustError('/')`, `(home)`, `('/usr/local')` non-null; `('~/Documents/a')` null.
- [ ] **Steps 2–5:** fail, implement, pass, commit.

### Task 5: `wh` for non-git copies

**Change from the design (my call, found while planning):** no `wh copy add`. `wh` can't load plugins, and calling
the running server over HTTP fails behind a hostname + sign-in. Instead each provider's `agentInstructions` give the
agent its own CLI's commands, then `wh worktree add --vcs <id>` records the copy (offline, like git today). So the
interface drops `createWorkingCopy`; plain folders are created by workspace-setup directly.

**Files:** Modify `scripts/wh.ts`; Test `scripts/wh.test.ts` (extend or create, temp `WORK_HUB_STATE_DIR`).

**Interfaces:** `wh worktree add <ws> --path <dir> [--vcs <id>] [--branch <line>]`: with `--vcs` other than git, records
it with `repo` from `--repo` or null and the given line; without `--vcs`, git detection exactly as today, and a directory
git doesn't know is recorded as `vcs folder` instead of failing.

- [ ] Tests: `worktree add` on a non-git dir records `vcs: 'folder'`, repo null; `--vcs jj --branch feat` records those;
  on a git dir output and record unchanged.
- [ ] Implement, pass, commit.

### Task 6: New workspace: source control choice and plain folders

**Files:** Modify `plugins/workspace-setup/dispatch.ts`, `server.ts`, `NewWorkspacePage.tsx`, `README.md`; Tests `plugins/workspace-setup/dispatch.test.ts`.

**Interfaces:** `POST /api/workspaces { ticket?, prompt?, vcs?: string, folder?: string, confirmFolder?: boolean }`.
With `folder`: path = `expandFolder(folder)` if absolute/`~`, else `<plainDir>/<folder>`; existing file → 400 "<path> is a
file"; outside both roots and not trusted and no `confirmFolder` → 409 `{ needsConfirm: path }`; else mkdir, `trustFolder`
(when outside roots), `trustWorktree`, create workspace (`vcs: 'folder'`, status `active`), `addWorktree(vcs 'folder')`,
start a `main` session in the folder with `ctx.prompts.workspaceContext(ws, prompt ?? 'Get oriented in this folder and wait for me.')`
(no explorer). With `vcs` (not folder): stored on the workspace; the explorer runs; `explorerPrompt` keeps today's text
when `vcs` is null or `'git'`, else replaces step 3 with `3. Create its working copies with ${provider.title}:` + the
provider's `agentInstructions`. `ticketWorkflowRules` fragment returns nothing when `kinds` lacks `'git'`.

- [ ] **Step 1: Failing tests:** explorer prompt for `vcs: null` and `'git'` equals today's (existing tests untouched pass);
  for a registered fake `jj` the step-3 lines are the provider's; dispatch with `folder: 'notes'` creates
  `<plain>/notes`, records it, starts one `main` session there (fake `ctx`), no explorer; a file at the path → error;
  an outside path without confirm → `needsConfirm`.
- [ ] **Step 2–4:** fail, implement (UI: a collapsed `<details>` "More options" with a Source control `<select>`
  (Detect + `ctx`-listed providers via `GET /api/vcs` core route returning `{ providers: [{ id, title, experimental }], default }`)
  and a Folder input; on 409 show `ConfirmPopover` "Let Claude sessions work in <path>?" then resend with
  `confirmFolder: true`), pass.
- [ ] **Step 5:** Commit.

### Task 7: Web display for non-git copies

**Files:** Modify `web/src/panels/WorktreeList.tsx`, `plugins/worktree-diff/*` (tab only for git copies),
`plugins/github/web.tsx` + `prLinks.ts` (PR chips/linking only for git), `plugins/terminals/web.tsx`,
`plugins/code/code.ts`, `builtin/session-tools/NewSessionBox.tsx` (labels); helper `copyLabel(t)` in `plugin-api/web.ts`.

**Interfaces:** `copyLabel(t: { vcs; repo; path; branch }): { name: string; detail: string | null }`: git → today's
`{ repo name, '@branch' }`; others → `{ basename(path), vcs === 'folder' ? null : `${vcs} ${branch ?? ''}` }`.

- [ ] Tests (pure `.ts`): `copyLabel` git unchanged; folder shows the folder name; `null` repo never throws; worktree-diff's
  "has git copies" predicate false for a folder-only workspace.
- [ ] Implement, check at 375px, commit.

### Task 8: jj provider plugin (experimental)

**Files:** Create `plugins/jj/{plugin.json,server.ts,provider.ts,provider.test.ts,README.md}`.

- `defaultEnabled: false`, title "Jujutsu (jj) — experimental". `detect` = `jj root` in the dir; `line` = bookmarks at `@`
  (`jj log -r @ --no-graph -T 'bookmarks'`), else change id (`-T 'change_id.short()'`); `sharedLines` = `main`, `master`,
  `trunk`; create = `jj -R <source> workspace add <path> --name <workspaceId> -r <base ?? 'trunk()'>`, then
  `jj -R <path> bookmark create <line> -r @` when `line` (these commands go in `agentInstructions`, followed by `<wh> worktree add <ws> --path <path> --vcs jj --branch <line>`);
  `inspect` dirty = non-empty `jj -R root diff --summary`;
  `removeWorkingCopy` = refuse when dirty unless force, `jj -R root workspace forget <name>` then remove the folder;
  working copies go under `<worktreesDir>/<repo>/<name>` like git's.
- [ ] Tests with a fake `jj` on PATH recording calls (pattern of `scripts/launchd.test.ts` stubs): each method's command
  line and parsing; the instructions name the create commands and `--vcs jj`; remove refuses dirty.
- [ ] Implement, pass, commit.

### Task 9: hg provider plugin (experimental)

Same shape as Task 8, `plugins/hg/`. `detect` = `hg root`; `line` = active bookmark (`hg log -r . -T '{activebookmark}'`)
else `hg branch`; `sharedLines` `default`; create (in `agentInstructions`) = `hg share <source> <path>`, `hg -R <path> update <base>`,
`hg -R <path> bookmark <line>`, then `wh worktree add … --vcs hg`; dirty = non-empty `hg -R root status`; remove = delete the share folder (refuse dirty
unless force). Fake-CLI tests; commit.

### Task 10: p4 provider plugin (experimental)

Same shape, `plugins/p4/`. Setting `templates` (list of `{ name, client }`, plugins.json only) shown in README.
`detect` = `p4 -d <dir> -F %clientRoot% info` root containing the dir (no call from reconcile: providers aren't asked
during polling); `line` = the client's `Stream` field; create (in `agentInstructions`, source = a template from the setting) =
`p4 client -t <template> -o <newClient>` with `Root:` replaced by the path, piped to `p4 client -i`, then
`p4 -c <newClient> sync`, then `wh worktree add … --vcs p4 --branch <client>`; client name `<user>-wh-<workspaceId>`; `inspect` dirty = non-empty `p4 -c <client> opened`,
plus shelved count (`p4 changes -s shelved -c <client>`); remove refuses either unless force, then `p4 client -d` and
delete the folder. Fake-CLI tests; commit.

### Task 11: Docs, full check, ship

**Files:** `CLAUDE.md` (Official plugins table rows jj/hg/p4; one paragraph under Workspace model on providers and
plain folders), `README.md` (a "Source control and plain folders" paragraph), `CHANGELOG.md`.

- [ ] `pnpm typecheck && pnpm test && pnpm build`; merge to main; deploy; `export-oss.sh` + publish (per the owner's flow).

## Later (not in this plan)

Optional diff members for jj/hg/p4 (Diff tab, recent changes, edit snapshots); the two git bugs from the survey (local
repo with no origin never auto-recorded; plain folder under the worktrees root never removable).
