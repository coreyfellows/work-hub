# Create plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Create plugin" button in Settings → Plugins opens `/plugins/new`; its form starts a work-hub workspace whose Claude session builds the described plugin (official in the work-hub repo, or local in a folder the user picks).

**Architecture:** A new official plugin `plugin-author` owns the page, the routes, the prompt and its `model` setting. The core gains three additive plugin-API members: `ctx.plugins` (read-only plugin list and plugins.json), `addDirs` on `ctx.sessions.startBackground` (→ `--add-dir`), and the `plugins-action` web slot. The route makes a work-hub worktree first, then the workspace, then the session, and rolls back on failure.

**Tech Stack:** Node 26 TypeScript (type stripping), Hono, React 19, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-06-create-plugin-design.md`

## Global Constraints

- Every core change is additive to `plugin-api/`; `API_VERSION` stays `1`. Each addition gets a line under CHANGELOG.md "Additions" dated 2026-11-06.
- Plugin files import only npm packages, files in the plugin, and `plugin-api/*` (boundary test).
- Plugin routes live under `/api/plugins/plugin-author/…`; JSON bodies via `readJson(c)`; polled GETs via `ctx.revalidate`.
- No personal paths, hostnames or accounts in tracked files.
- No horizontal scroll at 375px; buttons `.primary` for Create; errors inline under the form.
- Name rule: `^[a-z][a-z0-9-]*$`, not an id or alias of any discovered plugin, built-ins included.
- `model` setting: select, default `opus` (options fable, opus, sonnet, haiku).
- Official plugins must look and work the same: the only Settings change is a new row above the plugin list, empty when no plugin contributes.
- The real `POST /api/plugins/plugin-author/create` is never called in tests or by hand during this work.

## Review Focus

1. A local destination that is an existing non-empty folder not listed in plugins.json → 400 "not empty", nothing created. (Task 4 test `resolveDestination: unlisted non-empty folder`.)
2. A destination inside the work-hub checkout → 400 (it would land a local plugin in tracked files). (Task 4 test `validateCreate: destination inside the repo`.)
3. A listed folder-of-plugins with a name whose `<folder>/<id>` already exists and isn't empty → 400. (Task 4 test `resolveDestination: listed folder, child taken`.)
4. A name that collides with an alias (not an id) or a built-in id like `health` → 400 "taken". (Task 4 test `validateCreate: alias and built-in ids are taken`.)
5. A description with only whitespace, or `official` sent as the string "true" → 400. (Task 4 test `validateCreate: shape errors`.)

---

### Task 1: `addDirs` on `startBackground` → `--add-dir`

**Files:**
- Modify: `server/lib/sessions.ts` (`StartOptions`, `launchArgv`, `startBackgroundSession`)
- Modify: `plugin-api/server.ts:183` (`startBackground` opts type + doc)
- Test: `server/lib/sessions.test.ts`

**Interfaces:**
- Produces: `StartOptions.addDirs?: string[]`; `launchArgv(opts: Pick<StartOptions,'name'|'model'|'prompt'|'addDirs'>, extra?)`. `ctx.sessions.startBackground({ …, addDirs?: string[] })`.

Each entry becomes one `--add-dir=<dir>` argument (the `=` form: Claude's `--add-dir` is variadic, so `--add-dir <dir> <prompt>` would swallow the prompt as a second directory). Empty/blank entries are dropped. They go after `--model`, before plugin launch args.

- [ ] **Step 1: Failing test** `launchArgv: addDirs become --add-dir=<dir>, blanks dropped, before launch args`:
  `launchArgv({ prompt: 'p', addDirs: ['/a', ' ', '/b c'] }, ['--x'])` deep-equals `['--bg', '--add-dir=/a', '--add-dir=/b c', '--x', 'p']`; `launchArgv({ prompt: 'p', addDirs: [] })` equals `['--bg', 'p']`.
- [ ] **Step 2:** `node --test server/lib/sessions.test.ts` → FAIL.
- [ ] **Step 3:** Implement; widen the plugin-api type (index.ts already spreads `o` through).
- [ ] **Step 4:** Test passes.
- [ ] **Step 5:** Commit `Core: startBackground addDirs → --add-dir`.

### Task 2: `ctx.plugins` (read-only)

**Files:**
- Modify: `plugin-api/server.ts` (new `PluginListEntry` type, `plugins` member on `ServerPluginContext`, export the type)
- Modify: `server/plugins/context.ts` (`ContextDeps.plugins?`, wire into ctx with an empty default)
- Modify: `server/plugins/loader.ts` (pass `plugins` built from `resolution` and `deps.pluginsFile`)
- Test: `server/plugins/loader.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PluginListEntry { id: string; aliases: string[]; title: string; dir: string; kind: 'official' | 'local' | 'builtin'; status: 'active' | 'disabled' | 'replaced' | 'skipped'; reason?: string }
  plugins: { list(): PluginListEntry[]; config(): { local: string[]; enabled: Record<string, boolean> }; configFile: string }
  ```
  `list()` maps the live resolution at call time (fresh objects; mutating them changes nothing). `config()` re-reads plugins.json each call; a broken file throws its error. `configFile` = `deps.pluginsFile`.

- [ ] **Step 1: Failing test** `ctx.plugins: list has built-ins, official and local plugins with aliases; config reads plugins.json`: a loader run with an official plugin whose server stores `ctx.plugins` on `globalThis`, a manifest with `aliases: ['old-name']`, and a plugins.json with `local: [<dir>]`, `enabled: { x: false }`. Assert `list()` contains an entry `kind: 'builtin'` (e.g. id `health`), the official one `kind: 'official'` with `aliases: ['old-name']`, the local one `kind: 'local'`; `config()` deep-equals `{ local: [<dir>], enabled: { x: false } }`; `configFile` is the file path.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `node --test server/plugins/*.test.ts` passes.
- [ ] **Step 5:** Commit `Core: ctx.plugins (read-only plugin list and plugins.json)`.

### Task 3: `plugins-action` slot

**Files:**
- Modify: `plugin-api/web.ts` (`PluginsActionItem` interface, `'plugins-action'` in `SlotItems`)
- Modify: `web/src/pages/SettingsPage.tsx` (`PluginsSetting`: render items in a `div.plugins-actions` above the error list, only when there are items)
- Modify: `web/src/styles.css` (`.plugins-actions { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px }`)
- Test: `web/src/slots.test.ts`

**Interfaces:**
- Produces: `interface PluginsActionItem extends SlotBase { id: string; component: ComponentType }`.

- [ ] **Step 1: Failing test** `plugins-action items sort by order then registration`: contribute three typed `plugins-action` items (orders 50, default, 10) and assert ids come back `[c, a, b]` — the test fails to typecheck until the slot is typed; run `pnpm typecheck` as the failing check.
- [ ] **Step 2:** Implement type, render, CSS.
- [ ] **Step 3:** `node --test web/src/slots.test.ts` and `pnpm typecheck` pass.
- [ ] **Step 4:** Commit `Core: plugins-action slot at the top of Settings → Plugins`.

### Task 4: plugin-author pure logic

**Files:**
- Create: `plugins/plugin-author/create.ts`
- Test: `plugins/plugin-author/create.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const NAME_RE = /^[a-z][a-z0-9-]*$/;
  export interface CreateInput { name: string | null; official: boolean; defaultEnabled: boolean; destination: string | null; description: string }
  export function validateCreate(body: unknown, opts: { taken: Set<string>; officialAvailable: boolean; repoRoot: string }): { ok: true; input: CreateInput } | { ok: false; error: string };
  export type PathKind = 'missing' | 'empty-dir' | 'dir' | 'file';
  export interface Destination { addDir: string; pluginDir: string | null; folder: string | null; create: string }
  export function resolveDestination(input: { destination: string; name: string | null }, opts: { folders: string[]; kind: (p: string) => PathKind }): { ok: true; dest: Destination } | { ok: false; error: string };
  export function branchSlug(name: string | null, description: string, rand: string): string;
  export interface AuthorPromptOpts { workspaceId: string; input: CreateInput; dest: Destination | null; worktree: string; branch: string; base: string; appRepo: string; configFile: string; whCommand: string; rules: string[] }
  export function authorPrompt(o: AuthorPromptOpts): string;
  ```
- `validateCreate`: `description` trimmed non-empty; `official` a boolean; `defaultEnabled` boolean if present (default `true`; forced `true` for local per spec); name trimmed, `''` → null, else `NAME_RE` and not in `taken`; official requires `officialAvailable`; local requires `destination` absolute, normalized, not equal to or inside `repoRoot`. Official ignores `destination` (null).
- `resolveDestination`: `folders` = plugins.json local entries that are folders of plugins. If `destination` ∈ folders → `folder = destination`, `addDir = destination`, `pluginDir = name ? join(destination, name) : null` (if that child exists and isn't empty → error "`<path>` already exists and isn't empty"); `create = destination`. Else the destination is the plugin folder: kind `file` → error "not a folder", `dir` (non-empty) → error "already exists and isn't empty"; `pluginDir = addDir = create = destination`, `folder = null`.
- `branchSlug`: name → `name`; else kebab of the description's first 4 words (lowercase, `[^a-z0-9]+`→`-`, ≤24 chars, trimmed dashes) + `-` + `rand`; empty kebab → `new-<rand>`.
- `authorPrompt` content (each item a test assertion): the description verbatim; the id or "pick a short kebab-case id … not taken (check `GET /api/plugins`)"; official vs local and where to write (`plugins/<id>/` in the worktree, or `pluginDir`, or "a new subfolder `<folder>/<id>`"); `defaultEnabled` value for official; read-first list (`CLAUDE.md`, `docs/plugins.md`, `plugin-api/*.ts`, `CHANGELOG.md`, one or two similar official plugins); the API rules including the phrase "significant plugin-API change" and "bump `apiVersion`" only on the user's yes; the official checklist (plugin.json, entry files, README.md, tests, CLAUDE.md Official plugins row); the local checklist (`defaultEnabled: true`, `enabled[<id>]: true` and `local` in `configFile`, `pnpm check-plugin <folder>`); `pnpm typecheck` and `pnpm test`; commit/push by each repo's own rules, else commit, push if a remote, ask before merging; going live via AskUserQuestion unless the repo's rules say to deploy, official merged into `appRepo`'s branch first, restart with `scripts/update.sh --no-pull` from `appRepo`; `wh` note; final report with API change additive/breaking; ends with `rules` joined.

- [ ] **Step 1: Failing tests** (`create.test.ts`): `validateCreate: shape errors`, `validateCreate: name rule`, `validateCreate: alias and built-in ids are taken`, `validateCreate: official needs a git checkout`, `validateCreate: local needs an absolute destination`, `validateCreate: destination inside the repo`, `validateCreate: ok official / ok local`, `resolveDestination: listed folder with and without a name`, `resolveDestination: listed folder, child taken`, `resolveDestination: new path / empty dir is the plugin folder`, `resolveDestination: unlisted non-empty folder`, `resolveDestination: a file`, `branchSlug`, `authorPrompt: official`, `authorPrompt: local into folder, unnamed`, `authorPrompt: API rules and workspace rules last`.
- [ ] **Step 2:** `node --test plugins/plugin-author/create.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `create.ts`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit with Task 5.

### Task 5: plugin-author server

**Files:**
- Create: `plugins/plugin-author/plugin.json` (id `plugin-author`, title "Create plugin", `defaultEnabled: true`, `server`, `web`, `settings: [model]`)
- Create: `plugins/plugin-author/server.ts`

**Interfaces:**
- Consumes: Task 1 `addDirs`, Task 2 `ctx.plugins`, Task 4 everything.
- Produces routes:
  - `GET /api/plugins/plugin-author/options` (revalidated) → `{ officialAvailable: boolean, folders: Array<{ path: string; usable: boolean; why?: string }>, taken: string[] }`. `folders` = every plugins.json `local` entry; `usable` false with `why: 'a plugin, not a folder'` if it has `plugin.json`, `'not a folder'` if missing/file. `officialAvailable` = `git -C repoRoot rev-parse --show-toplevel` equals repoRoot's realpath (computed once, lazily).
  - `POST /api/plugins/plugin-author/create` → `{ ok: true, workspace }` or 400 `{ error }`.
- Create flow: validate → (local) resolve destination with `kind()` from `fs.statSync`/`readdirSync` → base = upstream of repoRoot's branch if `HEAD` is an ancestor of it, else the current branch, else `HEAD` → `git -C repoRoot worktree add <worktreesDir>/<repoName>/plugin-<slug> -b plugin-<slug> <base>` (`repoName` from `ctx.git.branchInfo(repoRoot).repo`'s name, else basename) → `trustWorktree` → (local) `mkdir -p dest.create` (remember whether it was created) → `createWorkspace({ title: 'Plugin: <name or first line ≤60>', origin: 'prompt', prompt: description, status: 'active' })` → `addWorktree` → `startBackground({ cwd: worktree, name: title, model, prompt: authorPrompt(…, rules: ctx.prompts.workspaceRules(id)), purpose: 'plugin-author', addDirs: dest ? [dest.addDir] : [] })` → `addSession(role 'author')` → `logEvent('dispatched', …)` → refresh `workspaces`, `claude`.
- Rollback on any failure after the worktree exists: `git worktree remove --force`, `git branch -D`, remove the created destination dir if still empty; if the workspace was created, mark it `done` and log `create-failed` with the error (the store has no delete; marking done keeps it off the front page — deviation from "deletes the workspace", noted in the report).

- [ ] **Step 1:** Write `plugin.json` and `server.ts`.
- [ ] **Step 2:** `node --test server/plugins/boundary.test.ts` and `pnpm typecheck` pass.
- [ ] **Step 3:** Commit `plugin-author: create logic and routes`.

### Task 6: plugin-author web

**Files:**
- Create: `plugins/plugin-author/web.tsx`, `plugins/plugin-author/NewPluginPage.tsx`, `plugins/plugin-author/styles.css`

**Interfaces:**
- Consumes: Task 3 slot, Task 5 routes.
- `register`: `page` `{ path: '/plugins/new', component: NewPluginPage }` (no nav); `plugins-action` `{ id: 'create-plugin', component: <Link to="/plugins/new" className="button primary">Create plugin</Link> }`; `palette-commands` "Create plugin" (group 'Plugins') → navigate.
- Page: back link to `/settings`; fields Name (optional, client-side `NAME_RE`/taken hint), Official switch (disabled with a muted note when `!officialAvailable`), On by default switch (only when official), Destination select (local only; unusable folders disabled with their `why`; "New folder…" shows an absolute-path input), "What should it do?" textarea (required), Create `.primary` (disabled until valid or busy), error inline. Navigate to `/workspaces/<id>` on success. One column; inputs `width:100%`, `min-width:0`, wrap long paths (`overflow-wrap:anywhere`).

- [ ] **Step 1:** Write the files.
- [ ] **Step 2:** `pnpm typecheck` and `pnpm build` pass.
- [ ] **Step 3:** Check `/plugins/new` and Settings at 375px (no horizontal scroll: `document.documentElement.scrollWidth <= 375`) with a dev server on spare ports; stop it by pid.
- [ ] **Step 4:** Commit `plugin-author: Create plugin page, button and palette command`.

### Task 7: Docs

**Files:**
- Modify: `CHANGELOG.md` (Additions 2026-11-06: `ctx.plugins` + `PluginListEntry`; `startBackground` `addDirs`; slot `plugins-action` row in the slot table and an Additions line; no version bump)
- Create: `plugins/plugin-author/README.md`
- Modify: `CLAUDE.md` (Official plugins table row; mention `plugins-action` in the slot list)
- Modify: `docs/plugins.md` (one line: Settings → Plugins → Create plugin starts a session that writes one for you)

- [ ] **Step 1:** Write docs.
- [ ] **Step 2:** `pnpm typecheck && pnpm test && pnpm build` all pass; record test counts.
- [ ] **Step 3:** Commit `plugin-author: docs`.

### Task 8: Ship

- [ ] Merge `main` into the branch if it moved; rerun the three checks.
- [ ] In `~/repos/work-hub`: `git merge create-plugin` into `main`, push `main`, deploy per `~/repos/work-hub-personal/CLAUDE.md`.
- [ ] `wh note <work-hub workspace> "Create plugin deployed: …"`.
