# plugin-author ("Create plugin")

A **Create plugin** button at the top of Settings → Plugins (and a "Create plugin" palette command) opens
`/plugins/new`. Describe what the plugin should do; **Create** makes a workspace whose Claude session builds it. You
watch and steer it from Chat like any other session; it asks before it goes live.

On by default.

## The form

- **Name** (optional): the plugin's id, `^[a-z][a-z0-9-]*$`, not an id or former id (alias) of any plugin, built-ins
  included. Blank: the session picks one.
- **Official**: the plugin goes in the work-hub repo (`plugins/<id>/`), with **On by default** for its
  `defaultEnabled`. Only offered when the app runs from a git checkout.
- **Destination** (local plugins): one of plugins.json's `local` folders that is a folder of plugins (the plugin goes
  in `<folder>/<id>/`; entries that are themselves a plugin, or missing, are shown disabled), or **New folder…**: an
  absolute path that doesn't exist yet or is empty, which becomes the plugin's own folder. Never inside the work-hub
  checkout.
- **What should it do?** (required).

## What Create does

`POST /api/plugins/plugin-author/create` (synchronous, like New workspace):

1. Validates the form (`validateCreate`, `resolveDestination` in `create.ts`).
2. Creates a work-hub worktree at `<worktrees folder>/<repo>/plugin-<slug>` on a new branch `plugin-<slug>` (slug: the
   name, else the description's first words plus 4 random hex digits). Its base is the app checkout's upstream when
   the checkout has nothing the upstream lacks, else the checkout's current branch, else its commit. The session never
   runs in the checkout the app runs from. It trusts the worktree for Claude.
3. Local only: creates the destination folder if missing (empty), and passes it to the session with `--add-dir`
   (`ctx.sessions.startBackground` `addDirs`), so it can write there without prompts. It doesn't write plugin files or
   plugins.json; the session does.
4. Creates the workspace (`Plugin: <name or first line>`, status active), records the worktree, starts the author
   session (role `author`, purpose `plugin-author`) with `authorPrompt()`, which ends with the core's workspace rules.

If anything fails after the worktree exists, it's taken back: the worktree and branch are removed, the folder it made
is removed while still empty, and a workspace already made is marked done with a `create-failed` event (the store has
no delete). The answer is 400 with the error.

The session is told: what to build and where; to read `CLAUDE.md`, `docs/plugins.md`, `plugin-api/*.ts`,
`CHANGELOG.md` and similar plugins first; the plugin-API rules (additive changes only, a breaking one only after a
question plainly labelled a significant plugin-API change, then bump `apiVersion`, migrate every official plugin and
add migration steps); the official or local checklist (README, tests, the CLAUDE.md table row; or plugins.json and
`pnpm check-plugin`); to run `pnpm typecheck` and `pnpm test`; to commit and push by each repo's own rules; and to ask
with AskUserQuestion before rebuilding and restarting (`scripts/update.sh --no-pull` in the app's checkout) unless the
repo's rules say to deploy.

## Routes

| route | what |
| --- | --- |
| `GET /api/plugins/plugin-author/options` | `{ officialAvailable, folders: [{ path, usable, why? }], taken, configError? }` for the form (ETag) |
| `POST /api/plugins/plugin-author/create` | `{ name?, official, defaultEnabled?, destination?, description }` → `{ ok, workspace }` or 400 `{ error }` |

## Slots

`page` (`/plugins/new`, no nav tab), `plugins-action` (the Create plugin button), `palette-commands` ("Create plugin").

## Settings

| key | env | default | what |
| --- | --- | --- | --- |
| `model` | `WORK_HUB_PLUGIN_AUTHOR_MODEL` | `opus` | the author session's model (fable, opus, sonnet, haiku) |

## Caveats

- Create starts a real Claude session and creates a worktree: the route isn't exercised by the tests (the pure parts
  are, in `create.test.ts`).
- Low data: the page makes one GET when opened and one POST; no polling.
- An unused worktree (a local plugin that needed no core change) is removed by the normal worktree cleanup when the
  session is closed.
