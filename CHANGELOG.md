# Changelog: plugin API

The plugin API is what a plugin may use: the manifest (`plugin.json`), the `ServerPluginContext` its `server.ts` gets,
the `WebPluginContext` its `web.tsx` gets, and the types and helpers exported from `plugin-api/server.ts` and
`plugin-api/web.ts`. This file records every version of it.

## Versioning policy

- The core supports exactly one version, `API_VERSION` in `plugin-api/manifest.ts`. Every manifest declares the version
  it was written for in `apiVersion`.
- **Additive changes don't bump it**: a new slot, a new `ctx` member, a new optional field or callback, a new exported
  helper or type. They're listed under the current version's "Additions" below.
- **A breaking change bumps it** (renaming or removing a member or slot, changing a signature, a required field, a
  behaviour plugins rely on). The same change:
  1. adds a `## Plugin API <n>` entry here with what changed and exact, agent-followable migration steps (the
     template under "Migrating");
  2. migrates every official plugin in `plugins/` and bumps their `apiVersion`.
- **No compatibility adapters.** A plugin on another `apiVersion` is skipped at startup with "needs plugin API v<n>
  (declares v<m>): see CHANGELOG.md, "Plugin API <n>" → "Migration steps"" on the Status page (a plugin newer than the
  app is told to update work-hub instead); the app keeps running without it. Its owner asks their agent to
  follow the migration steps.
- A plugin that throws while loading is skipped the same way ("failed to load: …"), and what it had registered that
  can be taken back is taken back (see `RegisterServerPlugin` in `plugin-api/server.ts`).

## Plugin API 1.0 (2026-11-04)

The first version.

### The import rule

Files under a plugin's folder may import only:

- npm packages (and `node:` builtins). A local plugin can't add dependencies to the host build: use what work-hub's
  `package.json` has.
- files inside the plugin's own folder;
- `plugin-api/*`: official plugins by relative path (`../../plugin-api/server.ts`), local plugins by the alias
  `work-hub/plugin-api/server` and `work-hub/plugin-api/web`. A local server plugin imports the alias **as types only**
  (`import type`), since Node strips those imports; its runtime helpers come from `ctx`. Web code is bundled by Vite,
  which maps the alias, so it may import values too.

Nothing under `server/` or `web/src/`. `server/plugins/boundary.test.ts` fails on any official plugin that breaks it, and
checks every `plugins/*/plugin.json` is a valid manifest whose entry files exist. For a local plugin the same check
(`server/plugins/boundary.ts`) logs a warning per offending import at startup (the plugin still loads), and
`pnpm check-plugin <folder>` runs it on demand.

### Manifest (`plugin.json`)

JSON, so Node, Vite and scripts read it without running code (`PluginManifest` in `plugin-api/manifest.ts`):

| field | type | meaning |
| --- | --- | --- |
| `id` | string, required | unique id; settings, env names, toggles and per-plugin state use it. `core` is reserved |
| `apiVersion` | number, required | the API version it was written for (`1`) |
| `title` | string | shown in Settings → Plugins and on the Status page (default: the id) |
| `description` | string | one line under the title |
| `defaultEnabled` | boolean | on unless the user switched it off (default `false`) |
| `replaces` | string | id of a plugin this one stands in for: while this one is on, that one is treated as off. Two active plugins replacing the same id are both skipped, with an error on the Status page |
| `requires` | string[] | ids that must be active; otherwise this one is skipped ("requires X, which is off"). Required plugins load first |
| `server` | string | server entry, relative to the folder (`server.ts`) |
| `web` | string | web entry (`web.tsx`); a `styles.css` at the top of the plugin's folder is imported with it, before the core's layout overrides |
| `claude` | string | informational: the plugin's Claude Code plugin folder (`claude`). The core doesn't read it; the plugin passes the folder itself (`sessions.addLaunchArgs` with `--plugin-dir`), or doesn't (app-rules adds its rules as a prompt fragment) |
| `webEntries` | object | extra HTML pages built beside the app (name → HTML file in the plugin folder, e.g. `{ "login": "login.html" }`), built to `dist/plugin-entries/<name>.html` while the plugin is active; the plugin serves them itself |
| `skills` | string | a folder of Claude Code skill folders (`<name>/SKILL.md`); while the plugin is active they are `/work-hub:<name>` in every session the app starts (added 2026-11-06) |
| `aliases` | string[] | former ids, so config saved under an old id still applies |
| `claudeVersion` | string | the Claude Code version the plugin was last updated for (claude-monitor reads it; added 2026-11-08) |

### Server: `ServerPluginContext`

`server.ts` exports `default function register(ctx: ServerPluginContext): void | Promise<void>`.

| member | what |
| --- | --- |
| `id`, `manifest`, `pluginDir` | the plugin's id, its parsed manifest, its folder |
| `app` | the Hono app; routes sit behind the core's guard. Use `/api/plugins/<id>/…` or your own `/api/…` paths; a route that would also match a core route (`CORE_ROUTES`; same method or `all`, `:param`/`*` match any segment) throws |
| `upgradeWebSocket` | Hono's WebSocket upgrade for the Node server |
| `publicOrigin` | the app's origin (`https://<hostname>`, or `http://127.0.0.1:<port>` in localhost mode); WebSocket routes check `Origin` with `isAcceptedOrigin` (exported below), which also accepts localhost |
| `isAcceptedOrigin(origin)` | that same check on the context, for local plugins (they import the API as types only) |
| `registry.add(source)`, `registry.refresh(id)`, `registry.on('change', fn)` | sources polled by the registry (`Source`: `id`, `title`, `intervalMs`, `local?`, `fetch()`), pushed to the browser over SSE; `add` throws for an id that already exists |
| `urgent(sourceId, listKey, fields)` | fields of a source's keyed list that low-data connections get at once |
| `revalidate(paths)` | GET JSON routes the UI polls get an ETag (empty 304 when unchanged); call before registering them |
| `db.migrate(migrations)`, `db.raw()` | the plugin's own SQL migrations (strings, run in order, each once, counted per plugin; append, never edit) and the `DatabaseSync` |
| `store` | the workspace store's functions (workspaces, worktrees, sessions, links, events) |
| `plugins.list()`, `plugins.config()`, `plugins.configFile` | read-only: every discovered plugin (built-ins included) with its status, and plugins.json's `local` and `enabled` (added 2026-11-06) |
| `sessions.list()` | the live Claude sessions |
| `sessions.find(id)` | a session by id or short id; on a miss the list is refreshed once and retried |
| `sessions.startBackground({ cwd, name?, model?, prompt, purpose?, addDirs? })` | `claude --bg` with every launch-args function applied (`addDirs`: one `--add-dir=<dir>` each, added 2026-11-06); emits `session-started` |
| `sessions.stop(s)` | `claude stop` (background) or SIGTERM (interactive); emits `session-stopped` |
| `sessions.trustWorktree(path)` | trust a folder under the worktrees root for Claude Code (so `claude --bg` starts there); agents use `wh trust <path>` |
| `sessions.typeInto`, `sessions.typeSequence`, `sessions.KEY_BYTES` | type text or keys into a background job (attach in a pty, type, detach) |
| `sessions.hide(pred)` | hide sessions from the `claude` source (e.g. headless runs of your own) |
| `sessions.addLaunchArgs(fn)` | extra `claude` arguments for sessions the core starts (`--plugin-dir`, `--settings`…). Claude keeps only the last `--settings`, so the core folds every inline-JSON `--settings` into one (objects merged, arrays concatenated) |
| `sessions.readHistory`, `findTranscript`, `lastActivity`, `sessionMeta`, `sessionUsage`, `sessionEdits` | transcript reading: condensed history, the transcript file, last assistant message time, metadata, per-response model and tokens, every recorded file change |
| `sessions.pendingQuestion`, `sessions.openQuestion` | whether an AskUserQuestion call is still unanswered; the session's open question entry (a form is up, so typed keys would answer it) |
| `sessions.transcriptState` | the cached transcript: its entries and each enricher's state by enricher id |
| `transcript.addEnricher(e)` | a `TranscriptEnricher` (`id`, `init?`, `onRecord?`, `onToolUse?`, `onToolResult?`, `resolve?`) adding fields to history entries; sessions already read are re-read |
| `prompts.addFragment(kind, fn)` | text added to prompts the core writes; kinds `workspace-rules`, `explorer`, `session-context`, `app-rules` |
| `prompts.fragments(kind, ctx?)` | the joined fragments of a kind, for your own prompts |
| `prompts.workspaceRules(workspaceId)` | the rules every workspace session's prompt ends with, as lines |
| `prompts.workspaceContext(ws, task)` | a workspace session's full prompt (what it's about, its rules, then `task`) |
| `files.addRoot(dir)`, `files.roots()` | let the file viewer serve files under a folder you own (still no secrets or `.git`) |
| `jobs.start(init, run)`, `jobs.registerResumer(kind, fn)` | background jobs in the header tray; a kind with a resumer survives a restart (save progress with `setPayload`) |
| `events.on(name, fn)`, `events.emit(name, payload)` | core events (`workspace-event`, `session-started`, `session-stopped`, `source-changed`, `job-finished`) and your own |
| `reconcile.addPass(fn)`, `reconcile.run()` | a pass in the reconcile loop (`ReconcilePass`: gets sessions and the store, returns whether it changed anything), and ask for a pass now |
| `auth.setProvider(p)` | who may use the app (`AuthProvider`: `isAuthed(c)`, `onUnauthed?(c)`, `publicPaths?`) |
| `guard.addPublicPaths(paths)` | paths reachable without signing in (exact, or a `*` prefix) |
| `onStart(fn)` | runs once the server is listening and the core's resume tasks have started; all plugins' hooks run at once, each with the plugin timeout |
| `paths` | `stateDir`, `configDir`, `cacheDir`, `repoRoot`, `reposDir`, `worktreesDir` (both read when used: the user can change them in Settings → Folders), `ticketWorkflowScripts` (resolved on every read: the bundled ticket-workflow scripts while that plugin is loaded, else `WORK_HUB_TW_SCRIPTS`, else empty), `whBin` (the plain path of this checkout's `bin/wh`), `whCommand` (the `wh` command line for prompts: `whBin`, quoted if needed, prefixed with `WORK_HUB_STATE_DIR='…'` etc. when the server's dirs aren't the `$HOME` defaults), and the plugin's own `pluginState` / `pluginCache` |
| `config.get(key, default?)` | env `WORK_HUB_<ID>_<KEY>` (upper snake case; coerced to the default's type), then `plugins.json` `settings[id][key]`, else the default |
| `exec.run`, `exec.runJson` | run a CLI (execFile, never a shell) |
| `headless.askClaudeJson(name, prompt, opts)` | a headless `claude -p` call that answers JSON; `opts.mcp: { name, url }` gives it that one HTTP MCP server's tools (one call at a time per server), without it the run has no tools |
| `git` | git helpers (`baseRef`, `branchInfo`, `parseRepo`, `worktreesByBranch`…) |
| `claude.pluginInstalled(name, opts?)` | whether the user has Claude plugin `name` installed (`claude plugin list --json`, a success cached 10 minutes; `scope` user/project/any, `enabledOnly`), so a bundled copy isn't loaded twice |
| `services.expose(name, api)`, `services.get(name)` | share an API between plugins (declare the provider in `requires`) |
| `log.info/warn/error` | logging tagged with the plugin |

`plugin-api/server.ts` also exports `API_VERSION`, `SESSION_MODELS`/`SessionModel`, `run`, `runJson`, `parseDiff`,
`askClaudeJson` (with `HeadlessMcp`, `HeadlessOptions`), `pluginInstalledChecker` (with `PluginInstalledFn`, `PluginInstalledOptions`), `baseRef`, `branchInfo`,
`parseRepo`, `worktreesByBranch`, `sessionDirs`, `publicOrigin`, `acceptedOrigins`, `isAcceptedOrigin`,
`publicAuthority`, `publicHost` (undefined in localhost mode), `HOST_ENRICHER_ID`, `ansiToHtml`, `invalidCommand`,
`readJson`, `JSON_BODY_REQUIRED`, and the types
`PluginManifest`, `Source`, `SourceState`, `Session`, `Workspace`, `Worktree`, `HistoryEntry`, `HistoryHost`, `FileEdit`,
`TranscriptEnricher`, `LaunchArgsFn`, `SessionPurpose`, `HidePredicate`, `ReconcilePass`, `Job`, `JobCtx`, `ResolvedPlugin`, `HubEvents`, `PromptContext`,
`PromptFragmentFn`, `PromptFragmentKind`, `PluginListEntry`, `AuthProvider`, `PluginMigration`, `PluginPaths`, `PluginLog`,
`ServerPluginContext`, `RegisterServerPlugin`.

### Web: `WebPluginContext`

`web.tsx` exports `default function register(ctx: WebPluginContext): void`.

| member | what |
| --- | --- |
| `id` | the plugin's id |
| `contribute(slot, item)` | add an item to a slot (tagged with the plugin's id) |
| `useSlot(slot)`, `slotItems(slot, opts?)` | read a slot's items (hook / plain), sorted by `order` (default 100), then registration order |
| `useSource(id)` | one source's live state |
| `get`, `post` | JSON fetch helpers (`post` sends the JSON the guard requires) |
| `ago` | "5m ago" formatting |
| `navigate`, `Link`, `usePath`, `match` | the router |
| `useLowData()` | whether Low data is on (stretch or drop polling when it is) |
| `usePersisted(key, initial)` | `useState` kept in localStorage under `wh.p.<id>.<key>` |
| `useToast()` | `show({ text, kind?, action? })` |
| `useIsPhone()` | phone width (≤700px) |
| `components` | the core's UI kit (`Modal`, `Menu`, `ConfirmPopover`, `AsOf`…: everything in `web/src/components/kit.ts`) |
| `highlightCode()` | highlight.js helpers, loaded on demand |
| `markdown` | the `Markdown` component (react-markdown + GFM with the `markdown-override` slot) |
| `SessionIdContext` | the session id of the view being drawn |

`plugin-api/web.ts` also re-exports the same things for a plugin's other files (`get`, `post`, `ago`, the router,
`useLowData`, `lowDataOn`, `useToast`, `useSlot`, `slotItems`, `useSource`, `useAllSources`, `Markdown`, `hastText`,
the kit, plus `buildTree`, `EditBody`, `EditSummary`, `splitPath` from the file browser), plus `fuzzyRank`, `LogViewContext`, `logTime`, `useHostProvider`, `useProviderHosts`, `WorkingPulse`, the
status helpers (`STATUS_LABEL`, `FINISHED`, `HIDDEN`, `displayStatus`, `showUnread`, `statusLabel`, `statusTitle`,
`trashHint`), `usePersistedPick`, `loadHighlightCode` (the lazy highlight.js chunk, as `ctx.highlightCode()`, from any file), `TerminalRunContext` (the "▶ Terminal" handler: the terminals plugin provides it on a
workspace page, command cards read it), `SessionIdContext`, `SESSION_MODELS` and `API_VERSION`.

### Web slots

Item types are in `plugin-api/web.ts` (`SlotItems`); every item has `plugin` (filled in) and an optional `order`.

| slot | item | what |
| --- | --- | --- |
| `page` | `PageItem` | a route (`path`: string, RegExp or matcher) and optionally a header tab (`nav`) and ⌘K entry |
| `session-view` | `SessionViewItem` | a view tab on a session (Terminal, Chat, Log…); `default`, `needsHistory`, `readable`, `liveDot`, `footer` (drawn under the scroll area while the view is active: the prompt box is Chat's) |
| `workspace-panel` | `WorkspacePanelItem` | a tab of the workspace page's right-hand switcher (`wide` slides over at laptop widths) |
| `workspace-section` | `WorkspaceSectionItem` | a section of the Details tab (`isEmpty`, `shownUrls`) |
| `workspace-tab-kind` | `WorkspaceTabKindItem` | things in the workspace tab strip besides sessions (`useTabs` hook) |
| `log-card` | `LogCardItem` | cards for conversation entries in Chat and Log (`match`, `render`, `run` to collapse runs, `label`, `Wrap`) |
| `markdown-override` | `MarkdownOverrideItem` | how a Markdown tag (`pre`, `code`, `p`, `li`, `td`, `a`) renders |
| `inline-text` | `InlineTextItem` | decorate plain text between URLs (the first non-null `render` wins) |
| `composer-addon` | `ComposerAddonItem` | something drawn with the prompt box (the Chat view's footer); gets the draft, `send`, the textarea and `registerKeyHandler` |
| `session-header` | `SessionHeaderItem` | a strip under a session's header |
| `workspace-action` | `WorkspaceActionItem` | an item in the workspace header's `⋯` menu (`useItem`, optional `dialog`) |
| `session-action` | `SessionActionItem` | an item in the session header's `⋯` menu |
| `tabstrip-action` | `TabstripActionItem` | an item in the workspace tab strip's `+` menu |
| `worktree-action` | `WorktreeActionItem` | a button on a worktree row in Details (`useData` once per workspace) |
| `pr-action` | `PrActionItem` | a button on the PR page |
| `pr-tab` | `PrTabItem` | a tab of its own on the PR page, after Checks (added 2026-11-06) |
| `workspace-list-action` | `WorkspaceListActionItem` | a button in the Workspaces page header |
| `workspace-card` | `WorkspaceCardItem` | an indicator on a workspace's card on the Workspaces page (added 2026-11-06) |
| `plugins-action` | `PluginsActionItem` | a button in a row at the top of Settings → Plugins (added 2026-11-06) |
| `settings-section` | `SettingsSectionItem` | a section on the plugin's own settings page (`scope: 'app'`: on the main Settings page) |
| `status-block` | `StatusBlockItem` | a block on the Status page |
| `health-issues` | `HealthIssuesItem` | issues for the connection dot and Status page (`collect(sources)`) |
| `app-banner` | `AppBannerItem` | a banner under the app header on every page (renders nothing when it has nothing to say) |
| `palette-items` | `PaletteItemsItem` | entries for the ⌘K palette |
| `palette-commands` | `PaletteCommandsItem` | commands for the palette's command mode (`>`); `commands(ctx)` gets the current workspace and session |
| `job-kind` | `JobKindItem` | how a job kind shows in the header tray (`icon`, `label`) |
| `link-kind` | `LinkKindItem` | what a workspace link is, for its tag in Links |
| `host-provider` | `HostProviderItem` | a resident host styling Chat, questions and the working bubble (first item wins) |
| `working-activity` | `WorkingActivityItem` | how busy Claude's screen is, for the working bubble (`useActivity` hook) |

A plugin may also use slot names of its own (any other string), or type one by augmenting `SlotItems`
(`declare module 'work-hub/plugin-api/web' { interface SlotItems { … } }`).

### Additions

Additive changes to 1.0 (still API 1: nothing to migrate), newest first, with the date.

- 2026-11-08 (Claude Code updates): manifest `claudeVersion?: string`, the Claude Code version (`x.y.z`) the plugin
  was last brought up to date with. The core doesn't read it; the claude-monitor plugin only suggests changes from newer
  Claude Code releases, and the sessions it starts to update a plugin set it. Additive: no version bump, nothing to
  migrate.
- 2026-11-08 (source control in the workspace model): `Worktree.vcs` (its provider id: `git`, `folder`, a plugin's
  id) and `Workspace.vcs` (the workspace's chosen provider, null = not chosen). `Worktree.repo` is now `string | null`:
  a plain folder has no repo, and another provider's copy may have none. **Local plugins:** handle a null `repo` (it
  was always a string), e.g. skip the row or fall back to `copyLabel(t)`, and check `vcs === 'git'` before running git
  in a recorded worktree. `ctx.store.addWorktree(id, { path, vcs?, repo?, branch?, baseBranch? })` takes `vcs`
  (default `git`) and an optional `repo`; `allWorktrees()` rows gain `vcs`; `findWorkspaceByWorktree`'s repo + branch
  match only considers git rows (a path still matches any kind). The core `GET /api/workspaces/:id/worktrees` route's
  rows (`WorktreeInfo`) gain `vcs`.
- 2026-11-08 (Web display for non-git copies): `copyLabel(t)` and `copyLabelText(t)` (and the `CopyLike` type) in
  `plugin-api/web.ts` and `plugin-api/server.ts`: how a working copy reads, `{ name, detail }` (a git copy is its repo
  name and `@branch`; a plain folder its folder name; another provider's copy its folder name and `<vcs> <branch>`).
  The `workspace-panel` slot item takes an optional `available(workspace)` to hide its tab where it doesn't apply
  (the Diff tab: a git copy, or no copies yet in a git or not-yet-chosen workspace).
- 2026-11-08 (New workspace: source control and folders): `ctx.paths.plainDir` (the plain workspaces root, read on
  use), `ctx.vcs.effectiveDefault()` (Settings → Source control's default id, or null for Detect or an unregistered
  one), and the exported helpers `expandFolder` and `folderTrustError` in `plugin-api/server.ts`. `ctx.store`'s
  `createWorkspace({ vcs })`, `setWorkspaceVcs`, `trustFolder` and `isTrustedFolder` are there for plugins too, and the
  new `deleteWorkspace(id)` (the record and everything under it, never files: for undoing a half-made workspace). Core
  `GET /api/vcs` (revalidated) answers `{ providers: [{ id, title, experimental }], default }`. `ConfirmPopover` was
  already in `plugin-api/web.ts`.
- 2026-11-08 (plain folders): `ctx.sessions.trustWorktree` also accepts a folder under Settings → Folders' "Plain
  workspaces" root (`config.paths.plain`, env `WORK_HUB_PLAIN_DIR`, default `~/workspaces`; only while that root
  itself passes `folderTrustError`) and a folder the user confirmed (`trusted_folders`). The New workspace form confirms
  through `POST /api/workspaces { …, confirmFolder: true }` (which calls `store.trustFolder`); core
  `POST /api/trusted-folders { path }` (guarded, tested) does the same for plugins and scripts. Settings → Source control (`vcs.default`) is the default provider
  id for `ctx.vcs.detect`'s `prefer`; `detect`, or a provider that isn't registered, means no preference.
- 2026-11-08 (source-control providers): `ctx.vcs` (`register`, `get`, `list`, `detect(path, { prefer? })`) and the
  types `SourceControlProvider`, `WorkingCopyState`, `AgentInstructionOpts`. The core registers `git` and `folder` (a
  plain directory: no identity or line, removing it only forgets the record); a plugin's providers are taken back if
  its `register()` throws. `detect` asks `prefer` first, then git, jj, hg, p4, the rest, folder last.
- 2026-11-08 (source-control providers): `PromptContext.kinds` for `workspace-rules` and `session-context` fragments:
  the workspace's source-control kinds (its chosen vcs, then its copies', deduped; `['git']` when none). Workspace
  rules end with each non-git kind's `agentInstructions`; a git-only workspace's rules read exactly as before.
- 2026-11-08 (no built-in MCP gateway): `askClaudeJson` takes `mcp: { name, url }` (types `HeadlessMcp`,
  `HeadlessOptions`) for the one MCP server a run may use, gated per server. A call without it now runs with no tools;
  it used to default to one company's MCP gateway, whose plugins (and the old `tools` value and `mcpUrl` option)
  left the repo with it. A local plugin that relied on that default passes `mcp` instead. The `health` built-in's
  `watchedMcp` and the `jiraBaseUrl` settings of `github` and `workspace-setup` now default to empty.
- 2026-11-06 (GitHub file links): `NewFileBody` takes an optional `highlight: { from, to }` (1-based, inclusive): the
  lines get a band and are scrolled into view.
- 2026-11-06 (work-hub skills): manifest `skills?: string`, a folder of Claude Code skill folders (`<name>/SKILL.md`).
  The core keeps one Claude plugin named `work-hub` at `<stateDir>/claude-plugin/work-hub`, rebuilds its `skills/` at
  every startup as links to the active plugins' skills (first plugin wins a name; problems are logged), and passes it as
  `--plugin-dir` to every session the app starts (not `headless` runs). So a skill is `/work-hub:<name>` only while its
  plugin is active, and `/reload-plugins` in a running session picks up the change after a restart. In a skill,
  `${CLAUDE_PLUGIN_ROOT}/skills/<name>/` is its own folder (Node scripts there see their real path). Also
  `HistoryEntry.localOutput?: string` on a user entry for a slash command Claude Code ran itself (`/reload-plugins`,
  `/model`…): its output, which means no reply is coming; the core's working bubble no longer waits for one.
- 2026-11-06 (PR summary): the `pr-tab` slot (`PrTabItem`: `id`, `label`, `component({ owner, repo, number, pr })`), a
  tab of its own on the PR page after Conversation, Files and Checks, drawn by the github plugin. `id` doubles as the
  tab's URL hash (`/prs/o/r/7#summary` opens it); the component mounts only while its tab is picked, and `pr` is the
  page's `PrDetail`, refreshed as the page polls. A hash naming no tab now falls back to Conversation, and the merge box
  shows on Conversation and Checks only. The scrutinize-pr plugin's Summary tab uses it. Additive: no version bump.
- 2026-11-06 (front page cards): the `workspace-card` slot (`WorkspaceCardItem`: `id`, `component({ workspace, sources })`),
  an indicator in the row under a workspace card's title on the Workspaces page. The github plugin's PR chips use it.
- 2026-11-06 (create plugin): three additive members, no version bump; no official plugin had to change.
  - `ctx.plugins` (read-only): `list()` gives every discovered plugin, built-ins included, as a fresh `PluginListEntry`
    (`id`, `aliases`, `title`, `dir`, `kind` `official | local | builtin`, `status`, `reason?`) with the status the
    loader gave it at call time; `config()` reads plugins.json's `local` and `enabled` on each call (a broken file
    throws); `configFile` is where plugins.json is (`WORK_HUB_PLUGINS_FILE`, else `<configDir>/plugins.json`). Exports
    the `PluginListEntry` type.
  - `ctx.sessions.startBackground({ …, addDirs?: string[] })`: folders outside `cwd` the session may use without
    permission prompts, one `--add-dir=<dir>` each (the `=` form, because the option is variadic and would otherwise
    read the prompt as another folder). `trustWorktree` still only trusts folders under the worktrees root.
  - Slot `plugins-action` (`PluginsActionItem`: `id`, `component`): a button or link in a wrapping row at the top of
    Settings → Plugins, above the plugin list; the row isn't drawn while the slot is empty. plugin-author's
    "Create plugin" uses it.
- 2026-11-06 (transcript gaps): `HistoryEntry.kind` may be `'notice'` (with `notice: 'away-summary'`, the recap
  Claude Code writes when you come back), and assistant entries may carry `narration: true` (a narration line: a thinking
  block the terminal shows). Slash commands you typed are user entries (`/name args`). Hook feedback and task
  notifications are kept out of the entries: `ctx.sessions.readNotices(sessionId, limit?)` lists them as
  `TranscriptNotice` (`kind` hook/task, `level` info/error/blocked, `title`, `text?`; exported from both plugin-api
  modules), `readHistory` returns their `noticeCount`, and so does `SessionHistory.noticeCount`. A renderer that switches
  on `kind` should handle (or skip) `'notice'`.
- 2026-11-06 (session awareness): workspace events know which Claude session logged them: `events.session_id` (core
  migration 15, the full session UUID or null), `WorkspaceEvent.sessionId`, `logEvent(workspaceId, type, detail?,
  sessionId?)`, the `workspace-event` payload's `sessionId`, and `store.listEvents(workspaceId, { types?, sessionId?,
  limit? })` (newest first, default 50). `ctx.sessions.boundWorktrees(sessionId)` returns the worktrees reconcile's
  transcript scan bound a session to. `wh claim <ws> <text>` and `wh done <ws> <text>` log `claim`/`done` events; `wh
  log`, `wh link add` (now logs a `link` event) and both attribute the event to the calling session from
  `CLAUDE_CODE_SESSION_ID` (a subagent: its job's session), `CLAUDE_JOB_DIR` or `--session <uuid>`. `plugin-api/web.ts`
  exports the core's `AsOf` component ("as of 3m ago ↻" for Low-data views).
- 2026-11-05 (keyboard shortcuts): slot `shortcut` (`ShortcutItem`: `group`, `keys` as `Mod+Shift+K` combos,
  `label`, `where?`) lists a plugin's keys in the header's ⌨ cheat sheet; `isMod(e, { shift? })`, `keyLabel(combo)` and
  `IS_MAC` from `plugin-api/web.ts` (`Mod` = ⌘ on a Mac, Ctrl elsewhere). See docs/keyboard-shortcuts.md.
- 2026-11-05 (platforms): `plugin-api/platform.ts` (Node builtins only, so standalone helper processes may import it):
  `platform()`, `isWindows()`, `ptyBridgeCommand(bridge, cols, rows, argv)` (spawn the core's ptybridge.py on `python3`,
  `python` on Windows or `WORK_HUB_PYTHON`), `pythonCommand()`, `defaultShell()`, `defaultTermdSocket(stateDir)` (a
  named pipe on Windows), `isNamedPipe()`, `isExecutableFile()`, `findOnPath()`, `gitBashPath()`, `keepAwakeCommand(pid)` and `normPath()` (one
  spelling for Windows paths from Claude, git and Git Bash). Use them instead of spawning `python3` or assuming `/`.
- 2026-11-05 (palette commands): the ⌘K palette has a command mode: a query starting with `>` lists commands, and `>`
  pressed outside an input or terminal (or ⇧⌘K / Ctrl+Shift+K anywhere) opens the palette that way. New slot `palette-commands` (`PaletteCommandsItem`:
  `commands(ctx: PaletteCommandContext): PaletteCommand[]`, called while the palette is open; `ctx` has `path`,
  `workspaceId` (its page or one of its sessions' pages), `sessionId` (a session page) and `sources`). A `PaletteCommand`
  is `{ id, label, hint?, group?, run(ctx) }`; a throw or rejected promise from `run` becomes an error toast. The core
  adds "Go to <page>" for every nav page, lock/unlock the layout and low data on/off; workspace-setup adds "New
  workspace", session-tools "New session in this workspace". Additive: no version bump.
  Also `usePaletteCommands(list | null)`: a component offers commands while it's mounted (read whenever the palette
  renders; on an id clash the one mounted last wins). The core uses it for what's on screen: the session view's ⋯ menu
  (`session-action` items: Intent, Hand off, Close session…) and "Show <view>" for its other view tabs, and the workspace
  page's ⋯ menu (`workspace-action`: Mark done…) and its tab strip's + menu (tab kinds' entries such as the terminals'
  "Terminal › <worktree>", closed sessions, add a running session, `tabstrip-action` items), so new items there show up as
  commands with no extra code. `MenuItem.palette: false` leaves an item out (session-tools' "New session", which has
  its own command). The core also lists "Settings: <plugin>" for every active plugin with its own settings page.

- 2026-11-05 (first-run offers): manifest `firstRunOffer?: { label, description?, ask?: { key, label, placeholder? } }`
  lists a plugin that is off on the first-run page as a checkbox; ticking it turns the plugin on in plugins.json
  (applies after a rebuild and restart) and stores the answer to `ask` as the plugin's setting `ask.key`. `GET
  /api/setup` gains `offers`, `POST /api/setup` takes `enable` and `offerValues` and answers `rebuild: true` when it
  turned something on. Menagerie uses it. Additive: no version bump.

- 2026-11-05 (menagerie standalone): `ctx.claude.pluginId(name, opts?)` answers the installed id
  (`<name>@<marketplace>`) of a Claude plugin, or null, from the same cached `claude plugin list --json` listing and
  scope rules as `ctx.claude.pluginInstalled` (a plugin can turn the user's own copy off for the sessions the app
  starts with inline `--settings '{"enabledPlugins":{"<id>":false}}'`). Exports `pluginChecks(runner, opts)` (both
  checks over one listing, for tests) and `mergeSettingsArgs(args)` (folds inline `--settings` args into one, as the
  core does for launch args). No official plugin had to change.

- 2026-11-05 (first-run questions): `SettingDef.firstRun?: boolean` asks that setting on the app's first-run page while it
  has no value (settings of different plugins sharing an `env` are asked once). Additive: no version bump.

- 2026-11-05 (plugin settings pages): every active plugin that declares `settings` or contributes a `settings-section`
  gets a page at `/settings/plugins/<id>`, linked as "Settings" from its row under Settings → Plugins: its manifest
  settings form first, then its sections. `SettingsSectionItem.scope: 'app'` keeps a section on the main Settings page
  (for what concerns the whole app, like sign out); without it a section moves to its plugin's page. Sections that were
  on the main page now sit on their plugin's page (menagerie's Fun toggle, auth's Passkeys and Other devices).

- 2026-11-05 (settings): a manifest may list `settings` (`SettingDef`: `key`, `label`, `description?`, `type`
  `string | text | number | boolean | select`, `default?`, `options?`, `min?`, `max?`, `placeholder?`, `restart?`, `env?`)
  and `settingsOrder?`. Settings shows a section titled with the plugin's `title` and stores edits in the app's database
  (`GET/POST /api/settings`, key `<plugin id>.<key>`). `ctx.config.get(key, default)` resolves a declared setting the way
  the page shows it: the env var (`env`, else `WORK_HUB_<PLUGIN>_<KEY>`), then plugins.json `settings`, then what
  Settings stored, then the default. Read it where it is used (not once in `register()`) for a change to apply with no
  restart; mark a setting read once with `restart: true`. Exports the `SettingDef` and `SettingValue` types.

- 2026-11-05: `SessionViewItem.footer` (a component the core draws under the scroll area while that view is active,
  given `SessionFooterProps`: `session`, `sessionId`, `history`, `host`, `working`, `stopping`, `stop()`, `pressKey()`,
  `keyBusy` and `send(text): Promise<void>`, which puts the message in the conversation as "sending…" and delivers it,
  rejecting if it couldn't be). The core no longer has a prompt box of its own: the conversation-view plugin's Chat
  view supplies it as its footer, so Terminal and Log have none. Also exports `usePersistedString` (the draft's
  localStorage hook, key `wh.draft.<session id>`) and the `SessionFooterProps` type.

- 2026-11-04 (last): stricter route-conflict rule: `ctx.app` now refuses any route that would also match a core route,
  not only an exact path. `CORE_ROUTES` lists `METHOD /path`; methods must agree unless either is `all`, and the plugin's
  `:param`, `:param?` and `*` match any core segment(s) (`POST /api/sessions/:id/:action` and `ALL /api/sessions/*` are
  refused; a `GET` on a core `POST` path, and anything under `/api/plugins/<id>/…`, is fine). Chained calls
  (`ctx.app.get(…).post(…)`), path-less calls and `ctx.app.basePath(…)` are checked too. No official plugin was affected.

- 2026-11-04 (later): exports `invalidCommand(command)` (why a command can't be typed into a session or terminal: one
  non-empty line, at most 2000 characters; or null) and `readJson(c)` (a route's JSON object body; an empty, unparsable
  or non-object body makes Hono answer `400 { error: 'JSON body required' }`, also exported as `JSON_BODY_REQUIRED`;
  a `try` around it should rethrow the `HTTPException` or return `err.getResponse()`). Both are runtime values, so
  official plugins import them by path; a local server plugin, which imports the API as types only, can copy them. The loader now enforces what
  was only advice: `register()` and each `onStart` hook get `WORK_HUB_PLUGIN_TIMEOUT_MS` (default 30s; a timed-out
  `register()` skips the plugin with "register() did not finish in 30s" and rolls it back like a throw, a timed-out or
  failing `onStart` is logged); `onStart` hooks of all plugins run at the same time (`Promise.allSettled`), not one
  after another; `ctx.registry.add` throws for a source id that already exists and `ctx.app` throws for a route on a
  core path (`CORE_ROUTES` in `server/coreRoutes.ts`, parameter names ignored), both skipping the plugin. Plugin routes
  belong under `/api/plugins/<id>/…`. `plugins.json` values of the wrong type are dropped with a warning (an `enabled`
  value must be `true`/`false`). New `ctx.paths.whCommand`: the `wh` command line to put in prompts (it may carry
  `WORK_HUB_STATE_DIR='…'` etc. in front, since `claude --bg` jobs don't inherit the server's env); `ctx.paths.whBin`
  stays the plain path. `addView`/`removeView` were removed from `ctx.store` (dead code: never documented, no users).
  Local plugins get a load-time warning for imports outside their folder and
  plugin-api, and `pnpm check-plugin <folder>` runs the import check on demand. Nothing that an official plugin did
  changes.

- 2026-11-04: `ctx.sessions.find(id)`, `ctx.sessions.trustWorktree(path)` (and the `wh trust <path>` CLI),
  `ctx.isAcceptedOrigin(origin)`; `loadHighlightCode` in `plugin-api/web.ts`. Slots whose items are hooks (`useActivity`,
  `useItem`, `useTabs`, `useHosts`…) are read once per mount (`useSlotOnce`), so contribute them at module init. Two
  routes moved from plugins to the core, unchanged: `POST /api/workspaces/:id/sessions/:sid/close` (was session-tools')
  and `GET /api/sessions/:id/file-edits` (was log-cards-edits').

## Migrating

Template for a breaking change's entry (copy it to the top of the versions above, fill it in):

```md
## Plugin API <n> (<YYYY-MM-DD>)

Why: <one sentence on what was wrong with the old shape>.

### Changes
- <member/slot/type>: <old> → <new>.

### Migration steps (for an agent; do them in order)
1. In `plugin.json`, set `"apiVersion": <n>`.
2. In `server.ts`: replace `ctx.<old>(…)` with `ctx.<new>(…)`; <what to do with its arguments and result>.
3. In `web.tsx` and its files: <slot or import changes>.
4. Run the plugin's checks (`pnpm typecheck` and `pnpm test` in its repo, or in work-hub for an official plugin),
   restart work-hub, and confirm the Status page lists the plugin as active.
```
