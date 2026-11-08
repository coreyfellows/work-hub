# Create plugin: authoring plugins from Settings

## Intent

work-hub is meant to be shaped by its user: almost every feature is a plugin. Today writing one means reading
`docs/plugins.md` and doing it by hand (or briefing a Claude session yourself). The owner wants a **Create plugin**
button at the top of Settings → Plugins that takes a description of what the plugin should do and hands it to a Claude
session that builds it, in a workspace the user watches and steers like any other.

The hard part isn't the form: it's that a new plugin may need things the plugin API doesn't offer yet. The session must
be allowed to change work-hub itself, but in a way that never forces rewrites of other people's local plugins.

## Goals

- One button, one short form, one new workspace with a session building the plugin.
- Official plugins land in the work-hub repo (`plugins/<id>/`); local ones in a folder the user picks.
- The session follows each repo's own rules for committing, pushing, merging and deploying (its CLAUDE.md).
- Core changes the plugin needs are **additive** to `plugin-api/`. A breaking change is the last resort, needs the
  user's explicit yes, and is unmistakably flagged.
- When done, the plugin goes live through the existing rebuild-and-restart path, after asking.

## Non-goals

- No template scaffolder or wizard that writes code without a session (the session writes everything).
- No plugin marketplace, publishing, or sharing flow.
- No editing of existing plugins from this form (a user can start a normal workspace for that).

## Anti-goals (failure even if it "works")

- A plugin that silently changes `plugin-api/` in a breaking way, or bumps `apiVersion` without the user saying yes.
- Official plugins broken or visibly re-laid-out by core changes made for the new plugin.
- Anything personal (paths, hostnames, accounts) written into tracked work-hub files.
- Edits landing in the app's running checkout (`~/repos/work-hub` main) instead of a worktree.

## Constraints

Everything in the repo's CLAUDE.md holds: core vs plugins split, `plugin-api/` the only import surface, the boundary
test, low data, no sideways scrolling at 375px, the confirm rule, localhost-first security, jobs for slow actions,
no plugin knobs in `server/config.ts`.

## What the owner decided

1. **Flow:** Create makes a new workspace and starts a Claude session in it that builds the plugin; the user steers it
   from Chat.
2. **Official?** A switch. When on, a second switch: **On by default** (`defaultEnabled`). The plugin is added to the
   work-hub repo.
3. **Local:** the user must pick a destination: a picker of the folders already in `plugins.json` → `local`, plus a
   field for a new path. If the destination is a git repo, the session commits and pushes by that repo's rules.
4. **Description:** a required free-text box: what the plugin does.
5. **Going live:** when typecheck and tests pass, the session asks the user (AskUserQuestion) whether to rebuild and
   restart now, unless the repo's rules already say to deploy, in which case it follows them.
6. **API rules** (given to the session verbatim in spirit):
   - Extend the plugin API as it exists; prefer additive changes.
   - Only if additive is impossible, a breaking change: first ask the user with a question plainly labelled as a
     significant plugin-API change (what breaks, why additive won't do, who has to migrate). On yes: bump `apiVersion`,
     migrate every official plugin in the same change, add migration steps to `CHANGELOG.md`, and repeat the warning in
     the final report.
   - Otherwise the session may change any work-hub behaviour the plugin needs, as long as the official plugins still
     work and lay out basically the same.

## Design (builder's calls marked)

### Where it lives

A new official plugin, **`plugin-author`** (title "Create plugin", `defaultEnabled: true`). *(my call: it's one feature,
so it's a plugin, not core.)* It owns its page, route, prompt and settings.

### Core additions (all additive, no `apiVersion` bump)

Each goes in `CHANGELOG.md` as an additive change.

1. **`ctx.plugins`** (server, read-only): `list()` → every discovered plugin, built-ins included, with id, aliases, dir,
   official/local/builtin and status (what the loader already resolved), and `config()` → the parsed `plugins.json`
   (`local`, `enabled`) wherever `WORK_HUB_PLUGINS_FILE` points. Used for the taken-id check (ids and aliases, built-ins
   included) and destination validation. *(my call: a plugin can't see either today.)*
2. **`addDirs?: string[]`** on `ctx.sessions.startBackground` → `--add-dir <dir>` per entry, so a session can write
   to a folder outside its cwd without permission prompts. *(my call: `trustWorktree` deliberately refuses paths outside
   the worktrees root, and this keeps that boundary.)*
3. A new slot, **`plugins-action`** (in `SlotItems`, `plugin-api/web.ts`): items `{ id, order?, component: ComponentType }`
rendered in a row at the top of the core's Plugins section (`PluginsSetting` in `web/src/pages/SettingsPage.tsx`),
above the plugin list. Document it in `CHANGELOG.md` as an additive change. `plugin-author` contributes a **Create
plugin** button (`.primary`) that navigates to its page. Also a `palette-commands` entry "Create plugin".

### The form: page `/plugins/new` (no nav tab)

*(my call: a page, like `/workspaces/new`, not a modal; it works on phones and in the palette.)*

- **Name** (optional): the session derives a kebab-case id if blank. If given, it's validated client- and server-side
  (`^[a-z][a-z0-9-]*$`, not an id already in `GET /api/plugins`).
- **Official** switch → **On by default** switch (shown only when official).
- **Destination** (local only, required): a select of `plugins.json` → `local` entries that are folders of plugins
  (an entry that is itself a plugin is shown disabled, "a plugin, not a folder"), plus "New folder…" which shows an
  absolute-path field.
- **What should it do?** textarea, required.
- **Create** (`.primary`). On success, navigate to the new workspace. Errors inline under the form.

The official option is only offered when the app's repo root is a git checkout *(my call: an extracted tarball can't
take an official plugin usefully; then it's local only, with a muted note)*.

### Route: `POST /api/plugins/plugin-author/create`

Body `{ name?, official, defaultEnabled?, destination?, description }` → `{ ok, workspace }` or 400 `{ error }`.
Synchronous like `POST /api/workspaces`, since starting a session is fast. Validation:
- `description` non-empty; `official` boolean.
- local: `destination` absolute; if it exists it must be a directory; if it's a listed folder-of-plugins the plugin goes
  in `<destination>/<id>/`, else `destination` is the plugin folder itself (must be empty or not exist). The route
  does **not** create files or edit `plugins.json`; the session does, so nothing half-made is left if the session never
  runs. *(my call)*
- the name, if given, as above: checked against `ctx.plugins.list()` ids and aliases, built-ins included.

Then: `ctx.store.createWorkspace({ title: 'Plugin: <name or first line of description>', origin: 'prompt', prompt:
description, status: 'active' })` (it returns the id). *(my call: not `setting-up`, which workspace-setup's resume would
hand to a generic explorer, and which blocks worktree removal.)* Start the session with `ctx.sessions.startBackground({ cwd, name: '<title>',
model, prompt, purpose: 'plugin-author' })`, `ctx.store.addSession(ws.id, { role: 'author', … })`, log a `dispatched`
event, refresh `workspaces` and `claude`. The cwd is always a work-hub worktree *(my call: the session must run work-hub's typecheck and tests, may need core
changes, and a worktree is trusted)*:
- create it first (`git worktree add <worktreesDir>/work-hub/plugin-<slug>
  -b plugin-<slug> <base>` from the app's repo root, base = the checkout's current branch's upstream or `main`), trust
  it (`ctx.sessions.trustWorktree`), record it on the workspace; cwd = that worktree. *(my call: doing it in the route
  means the session never starts in the app's live checkout.)* `<slug>` is the name, or `new-<short random>` if none.
- **local:** the destination (created if missing, empty) is passed with `addDirs`; the plugin is written there. The
  worktree is for any core changes the plugin needs; if none, it stays clean and the normal worktree cleanup removes it
  when the session closes.

If anything fails after the worktree is made (trust, start), the route removes the worktree and its branch, deletes
the workspace and returns 400 with the error. *(my call: nothing half-made.)* There's no resumer: a restart mid-request
is the same failure.

### The session prompt (`authorPrompt()`, pure, unit-tested)

Built from the form plus paths, ending with the core's `workspaceRules()` (so `workspace-rules` and `app-rules`
fragments apply). It tells the session:
- What to build (the description), the id or how to pick one, official vs local, `defaultEnabled`, where to write it.
- Read first: `CLAUDE.md`, `docs/plugins.md`, `plugin-api/*.ts`, `CHANGELOG.md`, and one or two similar official
  plugins.
- The API rules above, word for word in substance, including the breaking-change question.
- Official: write `plugins/<id>/` with `plugin.json`, entry files, `README.md`, tests, and a row in CLAUDE.md's
  Official plugins table. Local: write the plugin folder with `defaultEnabled: true`, set `enabled[<id>]: true`, add it to `plugins.json` → `local` if not covered by a listed
  folder (via `GET/POST /api/plugins/config`, or editing the file at `<configDir>/plugins.json`), and run
  `pnpm check-plugin <folder>`.
- Run `pnpm typecheck` and `pnpm test` (in work-hub) before calling it done.
- Commit and push by the target repo's own rules (its CLAUDE.md / CONTRIBUTING); if it has none, commit on the branch,
  push if there's a remote, and ask before merging.
- Going live: ask the user with AskUserQuestion whether to rebuild and restart now, unless the repo's rules say to
  deploy. For an official plugin the branch must first be in the checkout the app runs from (by the repo's merge rules).
  Restart with `scripts/update.sh --no-pull` from that checkout (Apply now's equivalent from a shell).
- Record the worktree, links and a plan note with `wh`; final report: what was built, where, whether the plugin API
  changed (additive / breaking, prominently), and how to turn it on.

### Settings (manifest `settings`)

| key | default | what |
| --- | --- | --- |
| `model` | `opus` | the author session's model |

### Low data and mobile

The form is a plain page with two GETs on open (`/api/plugins`, revalidated, and `/api/plugins/config`) and one POST; no polling. It
stacks in one column at 375px. The `plugins-action` row wraps.

### Tests

- `authorPrompt()` content: official vs local, the API rules present, defaultEnabled carried, workspace rules appended.
- Request validation (bad name, taken id, relative or non-directory destination, missing description) as a pure
  `validateCreate()`.
- Destination resolution (`<folder>/<id>` vs the folder itself) as a pure function.
- Core: `plugins-action` renders in order (a small web test like the other slot tests, if one exists for sections).
- Core: `addDirs` becomes `--add-dir` in `launchArgv`; `ctx.plugins.list()` includes built-ins and aliases.
- The route itself starts a real session: not called in tests (as with workspace-setup).

## Left to the builder

- Exact copy and styling of the form, within the UI rules.
- How the worktree base branch is resolved when the app checkout has no upstream.
- Whether the slug for an unnamed official plugin is random or derived from the description.
- README wording for `plugin-author`.
