# work-hub

A local dashboard that pulls the user's work context into one place (workspaces, Claude sessions, PRs, connection
health) and lets them act on it: prompt a Claude session, answer its questions, open a workspace, review a PR. It runs
on the user's own Mac, bound to loopback; almost every feature is a plugin. It has grown iteratively: favour small,
additive changes over rewrites.

You are working for the user, on their checkout. Nothing user-specific is tracked in the repo: their plugin toggles,
local plugin paths, settings, hostname and sign-in live in their config and state dirs, so `git pull` never conflicts
with their setup. Keep it that way (no personal hostnames, labels, paths or accounts in tracked files).

## Layout

- `server/`: the core. `index.ts` (Hono app: guard, SSE stream, core routes, static UI in production), `registry.ts`
  (source polling), `sources/claude.ts` (session discovery), `store/` (SQLite), `reconcile.ts`, `jobs.ts`,
  `workspaceSessions.ts`, `lib/` (session plumbing: `attach.ts` + `ptybridge.py`, `transcript.ts`, `sessions.ts`,
  `exec.ts`, `headless.ts`, `git.ts`, `prompts.ts`, `events.ts`, `sourceDelta.ts`, `platform.ts`…), `config.ts` (every core knob,
  overridable with `WORK_HUB_*` env vars), `plugins/` (discovery, resolver, loader, web-module generator).
- `web/src/`: the core web shell (router, header and nav, toasts, menus, palette, Settings and Status frames, the
  workspace and session page frames), `slots.ts` (the slot registry), `components/` (the UI kit plugins get).
- `plugin-api/`: `manifest.ts`, `server.ts`, `web.ts`: the only core modules plugins may import.
- `plugins/<id>/`: the official plugins, each with a `README.md` (what it does, routes, slots, settings).
- `bin/wh`: the CLI over the workspace DB. `scripts/`: dev runner, plugin generation, setup and update scripts.
- `CHANGELOG.md`: the plugin API's versions and migration steps. `docs/plugins.md`: writing a local plugin.

Node 26 runs the server's TypeScript directly (type stripping): `.ts`/`.tsx` extensions in relative imports, no
enums, namespaces or parameter properties (`erasableSyntaxOnly`, `verbatimModuleSyntax`). There's no server build
step; `pnpm build` builds the web bundle.

State: `$WORK_HUB_STATE_DIR` (default `~/.local/state/work-hub`: `hub.db`, per-plugin state), config:
`$WORK_HUB_CONFIG_DIR` (default `~/.config/work-hub`: `plugins.json`), cache: `$WORK_HUB_CACHE_DIR`.

## Platforms

macOS, Linux and native Windows. Everything that differs lives in `server/lib/platform.ts` (Node builtins only;
plugins and the standalone terminal daemon get it as `plugin-api/platform.ts`, tested with `WORK_HUB_PLATFORM`): idle
time (`ioreg`; Linux `xprintidle`, GNOME's IdleMonitor, `loginctl`; Windows one hidden PowerShell reading
`GetLastInputInfo`), the pty bridge's Python (`python3`, `python` on Windows, `WORK_HUB_PYTHON`; `ptybridge.py` uses
ConPTY through pywinpty there), the default terminal shell and termd socket (a named pipe on Windows), Git Bash's path,
and `normPath` for comparing paths from Claude, git and Git Bash on Windows. Don't spawn `python3`, assume `/` in
paths or write a mac-only command elsewhere: add it there. Setup scripts: launchd on macOS, systemd user units on Linux
(same bash scripts), Scheduled Tasks through the PowerShell twins in `scripts/windows/` (`docs/windows.md`). package.json
scripts must run under cmd.exe too (`scripts/env-run.ts` for env vars, double-quoted globs). Linux and Windows support is experimental (README):
Windows code has never run on Windows and the systemd units never on real systemd; whoever sets either up first fixes
what breaks and commits it back. Say so when you change that code.

## Core vs plugins

The core is what everything else depends on: the server shell and guard, the store (workspaces, worktrees, sessions
with roles, links, events, the migrations runner, `bin/wh`), the registry and SSE (watched/idle rules, deltas,
low-data batching, build-id reload), session discovery and plumbing (`claude agents`, job `state.json`, status rules,
unread, typing into jobs, reading transcripts, `claude --bg` start/stop), reconcile, jobs, and the web shell with its
slots. Everything else (conversation views, cards, terminals, GitHub, notes, auth…) is a plugin. If a change only
matters to one feature, it belongs in that feature's plugin; if a plugin needs something from the core that isn't in
`plugin-api/`, add it there (additively) rather than importing core internals.

## Plugin architecture

- **Manifest** `plugins/<id>/plugin.json`: `id`, `apiVersion` (1), `title`, `description`, `defaultEnabled`,
  `replaces?`, `requires?`, `server?` (`server.ts`), `web?` (`web.tsx`), `claude?` (a Claude Code plugin folder),
  `skills?` (skills for the shared `work-hub` Claude plugin), `aliases?`. JSON so Node, Vite and scripts read it without running code. Fields: `CHANGELOG.md`.
- **Config** `<configDir>/plugins.json` (`WORK_HUB_PLUGINS_FILE`; never tracked; missing = all defaults):
  `{ "local": ["/abs/plugin", "/abs/folder-of-plugins"], "enabled": { "<id>": true|false },
  "settings": { "<id>": { "<key>": value } } }`. Settings → Plugins edits `local` and `enabled` (applies after a
  rebuild and restart: its "Apply now", `server/applyRoute.ts`, runs `vite build` as an `apply` job, then exits when a
  supervisor will restart it: `WORK_HUB_REPO` from the setup scripts' agents, systemd, or `WORK_HUB_SUPERVISED=1`); `settings` is edited by hand or by setup guides.
- **Discovery and resolution** (`server/plugins/discover.ts`, `resolve.ts`, tested): official plugins (`plugins/*`)
  first, then local ones. A plugin is skipped (with its reason on the Status page) on a bad manifest, a duplicate id,
  another `apiVersion`, or a `requires` id that isn't active; it's off when `enabled` says so (by id or an alias), else
  `defaultEnabled`. `replaces: X` turns X off while the replacer is active; two active replacers of one id are both
  skipped with an error. The server loader and the web generator use the same resolver, so both halves agree.
- **Server** (`server/plugins/loader.ts`, `context.ts`): each active plugin's `server.ts` default export is called
  with a `ServerPluginContext`, required plugins first. Routes on `ctx.app` sit behind the core's guard. If it throws,
  it's skipped and what it registered is taken back (services, enrichers, launch args, reconcile passes, hide
  predicates, urgent fields, prompt fragments, file roots, public paths, auth provider; not routes, sources or event
  listeners, so register those last). `ctx.onStart` runs once the server listens.
- **Web**: `generateWebModule.ts` writes `web/src/plugins.generated.ts` (gitignored) on `pnpm dev`, `pnpm build` and
  before typecheck/test: one import per active plugin with a `web` entry, its `styles.css`, then its `register(ctx)`
  call; `web/src/layout-overrides.css` last, so the core's breakpoints win over plugin CSS. Local plugins are imported
  by absolute path; Vite maps `work-hub/plugin-api/web` for them.
- **Slots** (`web/src/slots.ts`): `ctx.contribute(slot, item)` / `useSlot(slot)`, sorted by `order` (default 100)
  then registration order. Every known slot and its item type is in `plugin-api/web.ts` (`SlotItems`): pages, session
  views, workspace panels and sections, workspace cards on the front page (`workspace-card`), tab kinds, log cards, Markdown overrides, composer addons, menu actions, Settings → Plugins actions (`plugins-action`),
  Settings and Status sections, health issues, palette items and commands (the palette's `>` mode), job and link kinds, the host provider, working activity, keyboard
  shortcuts for the header's ⌨ cheat sheet (`shortcut`; handle keys with `isMod`/`keyLabel`, never `e.metaKey`:
  docs/keyboard-shortcuts.md).
  A plugin may define its own slot names.
- **Server hooks** worth knowing: `registry.add` (sources), `urgent` and `revalidate` (low data), `db.migrate` (the
  plugin's own SQL migrations, counted per plugin in `plugin_migrations`; append, never edit an applied one),
  `transcript.addEnricher` (fields on history entries), `prompts.addFragment` (text in the prompts the core writes),
  `sessions.addLaunchArgs` (flags for sessions the app starts, e.g. `--plugin-dir <plugin>/claude`; inline `--settings` from several plugins are merged into one), `sessions.hide`,
  `jobs.start/registerResumer`, `events.on/emit`, `reconcile.addPass`, `files.addRoot`, `auth.setProvider`,
  `services.expose/get`. The full list is in `CHANGELOG.md` and `plugin-api/server.ts`.
- **Settings**: `ctx.config.get(key, default)` reads env `WORK_HUB_<ID>_<KEY>` (upper snake case, coerced to the
  default's type), then `plugins.json` `settings[id][key]`, else the default. Never add plugin knobs to
  `server/config.ts`.
- **Claude-side files**: a plugin's `claude/` folder (hooks, skills, rules, scripts) is passed only to the sessions the
  app starts (`addLaunchArgs`), never installed at user scope; turning the plugin off stops passing it.
- **Skills** (`/work-hub:<name>`): a manifest's `skills` folder (`<name>/SKILL.md` each) is linked into the core's shared
  `work-hub` Claude plugin (`server/lib/hubSkills.ts`, `<stateDir>/claude-plugin/work-hub`), rebuilt at every startup from
  the active plugins only and passed to every session the app starts, so `/reload-plugins` in a running session picks up
  plugins turned on or off since. Prefer this over a plugin's own `claude/` folder for skills.
- **Versioning**: plugins declare `apiVersion`; additive changes don't bump it, breaking ones bump it, add migration
  steps to `CHANGELOG.md` and migrate every official plugin in the same change. No adapters.

## Adding a plugin

1. `plugins/<id>/plugin.json` (official) or a folder of the user's own listed in `plugins.json` `local` (see
   `docs/plugins.md`).
2. `server.ts`: `export default function register(ctx: ServerPluginContext)`. Routes under `/api/plugins/<id>/…` (or
   paths it owns; a route that would also match one in `CORE_ROUTES` (`server/coreRoutes.ts`, `METHOD /path`; the plugin's
   `:param`/`*` match any segment, same method or `all`) throws and skips the plugin: add new core routes to that list,
   `coreRoutes.test.ts` checks it), `ctx.revalidate([...])` before polled GET routes, sources via
   `ctx.registry.add` (a duplicate id throws). JSON bodies through `readJson(c)` (400 "JSON body required" instead of a
   500). `register()` and each `onStart` must finish within `WORK_HUB_PLUGIN_TIMEOUT_MS` (30s): slow work goes in
   `onStart` or runs lazily.
3. `web.tsx`: `export default function register(ctx: WebPluginContext)`, contributing slot items; `styles.css` beside
   it for its CSS (class names prefixed by the feature).
4. Tests as `plugins/<id>/*.test.ts` (`pnpm test` globs them; pure `.ts` for web tests).
5. `README.md`: what it does, routes, slots, settings (key, env, default), caveats. Add a row to the table below.
6. Imports: npm packages, files inside the plugin, and `plugin-api/*` only. `server/plugins/boundary.test.ts` fails
   otherwise (and on a manifest whose entry files are missing). The other way round too: core code (`server/`,
   `web/src/`) never imports from `plugins/` (a short allowlist, `CORE_IMPORT_ALLOWED`, covers the generated web module
   and two integration tests); a plugin's tests live in its own folder. Local plugins: a load-time warning, and
   `pnpm check-plugin <folder>`.
7. Check it against "Every feature: plan for low data" and the mobile rule below.

Prefer CLIs already authenticated on the machine (`gh`, `claude`) over storing tokens. Things only reachable through an
MCP server (Slack, Jira, Google… behind a company gateway) go through `ctx.headless.askClaudeJson` with `mcp: { name,
url }`: a headless `claude -p` with `--strict-mcp-config` and only that server's tools, one call at a time per server and
a pause after it reports a session cap (`server/lib/mcpGate.ts`). Name the exact tools in the prompt, cap the calls
(search APIs are often rate-limited per org), and back the model's filtering with a deterministic filter in code.
Nothing tied to one employer's services belongs in this repo: such plugins live in the user's own local plugin folder.

## Workspace model (explicit, not inferred)

A workspace is the unit of work: a ticket or prompt, a status (setting-up/active/parked/done), worktrees, Claude
sessions (with a role), links and an activity log, in SQLite at `<stateDir>/hub.db` (`server/store/`; `node:sqlite`,
WAL; core schema changes are new entries in the core MIGRATIONS, plugin ones go through `ctx.db.migrate`). Live state
(session status, PR checks) is overlaid in the UI by matching session ids and branches.

- `bin/wh` is the CLI over the same DB; agents use it to record worktrees, links, notes, title and status, and to trust a
  new worktree for `claude --bg` (`wh trust <path>`, the same `trustWorktree` as `ctx.sessions.trustWorktree`). Events it
  logs (`wh claim <ws> <text>`, `wh done <ws> <text>`, `wh log`, `wh link add`) carry the calling session's id
  (`events.session_id`, from `CLAUDE_CODE_SESSION_ID`, a subagent's job dir, or `--session`); `store.listEvents` filters
  by type and session.
- Renaming: a workspace's title (`POST /api/workspaces/:id/title`) and a session's name (`POST /api/sessions/:id/name`, kept in
  `session_names` and overlaid on what `claude agents` reports; an empty name resets it) are edited in place with
  `EditableTitle` in the workspace header and the session header (shown in the embedded view too).
- Live sessions not in any workspace show as "Unassigned" with an assign picker. Done and stopped sessions (`HIDDEN`
  in `web/src/status.ts`) are left out of workspace tabs and cards; failed ones stay.
- The front page groups by state; an idle workspace is "Warm" while its latest session activity
  (`Session.lastActiveAt`, the last assistant message's time) is under the cutoff (Settings → Workspaces,
  `web/src/recentIdle.ts`), else "Idle for a while".

## Claude sessions: found and driven

- `claude agents --json --all` lists sessions; background jobs' state, open question and result come from
  `~/.claude/jobs/<shortId>/state.json`. Status rules live in `server/lib/sessionStatus.ts` (tested), most live signal
  first: busy or `tempo: active` = working; an open AskUserQuestion or a menu = waiting on the user; background work in
  flight = still working; then state.json's `blocked`, only if it isn't older than the last assistant message.
  Working only because of background work (turn over: `tempo` not active, since `claude agents` says busy either way) is
  `Session.waitingOnTasks`, with `tasks` (state.json `fan`, each described by its Bash call's `description`): the badge
  shows "waiting" (`sessionShownStatus`: ranked with warm in the palette, unread dot like warm) and drops the Chat
  working bubble. Whenever any background task runs, `TaskStrip` sits above the prompt box (every view); a tap lists the
  tasks with their progress (`GET /api/sessions/:id/tasks`, `server/lib/taskProgress.ts`: a shell's last output lines, an
  agent's steps and latest action, read from the `.output` file the transcript named).
- `GET /api/sessions/:id/file-edits?path=` (core) lists a session's recorded changes to one file (the `edit`/`edits`
  fields plugins' enrichers add); session-stats' Files changed modal reads it.
- Unread (`server/store/sessionReads.ts`): last assistant message newer than when the user last looked; the session
  page posts `/seen` while it's visible.
- Everything the app starts is a background job (`claude --bg`, via `startBackgroundSession`), because only those are
  reachable from outside: `server/lib/attach.ts` types into one by attaching in a pseudo-terminal (`ptybridge.py`) and
  detaching. Interactive sessions show busy/idle only. Keys are allow-listed in `index.ts`.
- Sibling awareness is the session-awareness plugin: a per-workspace digest (a block per open session: status, claim and
  done lines, worktree, PRs, commits, edited files and overlaps) rebuilt on events and a `hub.db` file watch, added to
  start prompts, and a `--settings` hook that tells an app-started session only what changed about its siblings.
- Closing a workspace session is core (`POST /api/workspaces/:id/sessions/:sid/close`: stop it, keep its record, log
  `session-closed`): the ✕ on a session tab and session-tools' "Close session" both post there.
- Worktree cleanup is core too (`server/worktreeRoutes.ts`, `server/lib/worktreeCleanup.ts`, tested against real git repos): a
  worktree is "orphaned" when no open session (not done/stopped, any workspace) has its cwd inside it. Closing a session removes
  the worktrees only it used when Settings → Folders → "Remove a session's worktrees when it is closed" is on (default) and
  nothing is lost: no uncommitted or untracked files, every commit already on another branch or a remote; otherwise they stay
  (`worktree-kept` event). Only linked worktrees under the worktrees folder are ever removed, never a repo's own checkout, and
  the branch stays. The Details → Worktrees section (`web/src/panels/WorktreeList.tsx`, `GET /api/workspaces/:id/worktrees`,
  loaded when it opens and when a session opens or closes, ↻ for the rest) groups them by open session, with an "Orphaned"
  group whose button (`POST …/worktrees/remove {orphaned: true}`) removes the safe ones; a per-row Remove… (confirmed) is the
  only way to discard changes (`force`, named paths only).
- Every prompt the core writes for a workspace session ends with `workspaceRules()` (`workspaceSessions.ts`): sibling
  sessions only as plain `claude --bg` jobs in a recorded worktree, record with `wh`; plugins add to it with
  `workspace-rules` fragments, and `app-rules` fragments reach every session the app starts.
- The conversation itself comes from the transcript (`server/lib/transcript.ts`, enriched by plugins); views and cards
  are the conversation-view plugin: its features (edit-cards, git-cards, command-runs, questions, file-links, bash-snapshots) live in `plugins/conversation-view/<feature>/`. The prompt box is the Chat view's `footer` (`composer/`; the core only owns `send`, pending messages and the input sinks), so Terminal and Log have none: the live terminal takes typing directly.

## Reconciling sessions, worktrees and PRs

Sessions don't reliably run `wh`, so `server/reconcile.ts` (tested) backs it up after every `claude` source change (or
`ctx.reconcile.run()`), one pass at a time: an unrecorded session joins the workspace whose recorded worktree it runs
in (deepest path; else a unique repo + branch, never main/master), or the workspace whose session started it (the
`claude attach <id>` line `claude --bg` prints, as a whole line of a Bash result); a workspace session's git toplevel
under the worktrees root is recorded as a worktree, and recorded worktrees follow branch renames. A session is also **bound** to worktrees it made or moved into, wherever it started (`claude agents` only knows its start
folder): `server/lib/sessionWorktrees.ts` reads a workspace session's transcript incrementally (`session_worktree_scans`,
migration 14) for Bash `git worktree add <p>`, `cd <p>`, `git -C <p>`, `--path <p>` and Edit/Write inside a folder under the
worktrees root (reads don't count) into `session_worktrees`; a bound open session keeps a worktree from being "orphaned", and
closing the session removes the worktrees it was bound to or started in when nothing else is open there and nothing would be
lost (Settings → Folders switch as before); a found worktree nothing records is recorded if it is a real git toplevel of the
session's repo. Plugins add passes
(the github plugin links PRs). Anything a plugin runs headless inside a recorded worktree must be hidden
(`ctx.sessions.hide`) or reconcile adopts it.

## Background jobs

Slow actions run as server-side jobs (`server/jobs.ts`, `ctx.jobs.start`): the route answers `202 { jobId }` after
validating, the work carries on, and the header tray (`components/JobTray.tsx`, fed by the `jobs` source) shows
progress, detail and a link to the result. Jobs are in SQLite, so the tray survives a restart; a kind with a resumer
(`registerResumer`, progress saved with `setPayload`) is run again at startup, any other running job comes back failed.

## UI rules

- **Confirm rule:** destructive or hard-to-reverse actions use `ConfirmPopover` (anchored, never reflows the row).
  Reversible ones act at once and show a toast (with Undo where it makes sense). No in-place "Really?" swaps. A popover
  opened from inside a `Menu` is unmounted with it, so destructive items sit beside the menu.
- `useToast().show(…)` for action errors and "done" notices; errors tied to a loaded view stay inline.
- Buttons: default, `.primary`, `.ghost`, `.danger`, `.icon` (glyph only, needs `aria-label`; 40px on touch).
- The 🔒 in the header unlocks layout editing: tabs, Details sections and a workspace's session/terminal tabs can be
  reordered (one layout for every workspace and device: `ui_prefs`, `GET/POST /api/layout`, `web/src/layout.ts`;
  unknown ids are ignored, new ones appear at their default spot).

## Security: localhost first (don't weaken)

The API can type into terminals running Claude with tool access, so it's effectively remote code execution. The guard is
fixed core (`server/guard.ts`, tested in `server/security.test.ts`); sign-in is the `auth` plugin's (plugins/auth/README.md).

- Node binds to 127.0.0.1 only, always. Other devices reach it only through a TLS front (`scripts/setup-lan.sh`: Caddy
  with an mkcert certificate; Caddy because the macOS firewall prompts for or blocks a LAN-listening node).
- **Localhost mode (default, no `WORK_HUB_HOSTNAME`):** Host must be `127.0.0.1:<port>` or `localhost:<port>` (plus the
  Vite dev port only when `WORK_HUB_DEV=1`, which `pnpm dev` sets), and there is no cookie or login. Safe only because
  nothing off this machine can reach it. "This machine" means every local process and every macOS account on the Mac:
  any of them can drive your sessions. So a request carrying `X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`,
  `X-Real-IP` or `CF-Connecting-IP` (a tunnel or reverse proxy that rewrote Host) gets 403 "proxied request in localhost
  mode; set WORK_HUB_HOSTNAME and enable the auth plugin", and a GET to `/api/*` whose `Sec-Fetch-Site` is present and not
  `same-origin`/`none` (another web page, even one on another localhost port) gets 403: some GETs start work
  (`/api/events` wakes polling that spends tokens; the slash-command list runs `claude -p`).
- The auth plugin on without a hostname sets its `Secure` cookie over http://127.0.0.1: Safari won't keep it, so
  sign-in loops there. Use auth together with a hostname (its purpose), or another browser.
- **Hostname set:** only that Host is accepted (raw IPs, loopback names and DNS rebinding get 403), and the server
  refuses to start unless an auth provider registered (`assertStartupSafe`: "WORK_HUB_HOSTNAME is set but the auth plugin
  is off…"). The auth plugin then requires its `wh_auth` cookie on everything but `/login*`, `/assets/*` and `/ca.pem`
  (token, pairing QR, passkeys with the hostname as RP ID, a 10-per-10-minutes sign-in brake kept in SQLite).
- Writes must be JSON with no Origin or an accepted one (`acceptedOrigins` in config.ts) (CSRF). WebSocket routes check
  Origin themselves with `isAcceptedOrigin` from plugin-api/server.ts.
- Helper servers (SilverBullet, VS Code serve-web, the terminal daemon's socket) listen on loopback or a 0600 socket
  in the 0700 state dir only; anything served beside the app on its origin (notes, code) goes behind `forward_auth` to
  `/auth-check`.

Keep all of these when adding routes or changing the server.

## Token budget: work only while watched

`Registry` (`server/registry.ts`) polls nothing unless a visible browser tab holds an SSE connection *and* the machine
has had keyboard/mouse input within `WORK_HUB_IDLE_MS` (10 min). The client closes its EventSource when the tab is
hidden; stale sources refresh as soon as both are true again; manual ↻ always runs. Sources marked `local: true` (free,
no tokens: workspaces, sessions, jobs) load at startup and on connect and keep polling while a viewer is connected. Any
source that spends tokens must go through the registry, never its own timer.

## Data use and low-data mode

Always on: the SSE stream sends each source whole once per connection, then only `source-patch` deltas
(`server/lib/sourceDelta.ts`, keyed lists by `sessionId`/`id`); polled GET JSON routes revalidate with an ETag
(`server/lib/revalidate.ts`; `ctx.revalidate` for plugins; never on a streaming route). After a deploy, open tabs on
an older build reload (or show "New version ↻" if something is typed or a dialog is open).
Low data (Settings → Data, per device, `useLowData()` in `web/src/lowData.ts`): non-urgent source changes are batched
to one per `WORK_HUB_LOW_DATA_BATCH_MS` (10s), urgent ones (`isUrgent`, plus each plugin's `ctx.urgent` fields) go at
once; heavy views wait for a tap.

## Every feature: plan for low data

The user may run the app from a phone on cellular data with Low data on, so every feature must work there without
wasting data, and behave exactly as specified with Low data off. Before calling a feature done, check:

- **Polling:** any interval poll reads `useLowData()` and, when on, stretches it (~10s) or drops it and loads on
  open/tap, showing `<AsOf>` ("as of 3m ago ↻") wherever data can go stale.
- **Polled GET JSON:** register the route with `ctx.revalidate` (or the core list in `index.ts`).
- **Live state:** put it in a registry source so it rides the SSE deltas; a field the user would act on (needs them,
  finished, failed) goes in `ctx.urgent` (core: `URGENT` in `sourceDelta.ts`, with a test).
- **Streams and heavy views** (WebSockets, terminals, iframes, big diffs or files): don't open them by default in low
  data; offer a tap to start, and fetch big payloads only when opened.
- **Core actions stay instant:** answering questions, sending prompts, Run, keys.
- **Measure it** if the feature moves data often: bytes on a session or workspace page for a minute, on and off.

## Mobile: never scroll sideways

At phone width (`max-width: 700px`) **no page may need horizontal scrolling**. `html, body` clip `overflow-x`, but that
only hides a bug. New UI must wrap, shrink (`min-width: 0` on flex/grid children) or scroll *inside its own box* (code,
diffs, tables, terminals). On phones the header's tabs fold into a hamburger menu; a `page` slot item with `nav` lands
there by itself. Check new layouts at ~375px wide.

## Wide screens

The workspace page stays two columns at any width (left: sessions and terminals; right: the Details/Diff/Note/Code
switcher). Widths are capped in the media queries in `web/src/layout-overrides.css` (`.ws-page`, `.page`,
`.session-page` grow at 1800px and 2400px; the right column is one width for every tab, so switching tabs never shifts
the layout; at laptop widths `wide` panels slide over the terminal column). Don't add a third column or let content
stretch unbounded: cap widths in those media queries.

## Official plugins

Each lives in `plugins/<id>/` with its own README (what it does, routes, slots, settings). The rows marked "built in" are the app's own features (`builtin/<id>/`: always on, loaded before the plugins through the same loader, manifests and settings in `server/builtin.ts`, web halves in `web/src/builtin.ts`); they aren't in Settings → Plugins.

**Settings** (`server/settings.ts`, `server/settingsRoute.ts`, `web/src/pages/AppSettings.tsx`): a plugin or built-in feature lists `settings` in its manifest (`SettingDef`) and Settings shows a section for it, stored in the `app_settings` table (migration 13) under `<id>.<key>`. `ctx.config.get` resolves a declared setting as Settings shows it: env var, then plugins.json `settings`, then what Settings stored, then the default. A field marked `restart` is read once at startup. A plugin's settings (declared ones and its `settings-section` items) sit on its own page, `/settings/plugins/<id>` (`web/src/pages/PluginSettingsPage.tsx`), linked as "Settings" from its row under Plugins; the main Settings page has the app's own sections (a section opts in with `scope: 'app'`).

| id | what | README |
| --- | --- | --- |
| ↳ health (built in) | sign-in checks, MCP status, connection-dot issues | builtin/health/README.md |
| github | PR lists, the PR preview (/prs/:owner/:repo/:number), PR sessions, PR linking | plugins/github/README.md |
| worktree-diff | the workspace Diff tab and the pr-changes check | plugins/worktree-diff/README.md |
| notes | a SilverBullet note per workspace, its Note tab (off by default; `setup/SETUP.md`) | plugins/notes/README.md |
| code | VS Code (serve-web) for a workspace's worktrees, its Code tab (off by default; `setup/SETUP.md`) | plugins/code/README.md |
| terminals | shells that outlive restarts: /terminal, workspace terminal tabs, "▶ Terminal" script runs | plugins/terminals/README.md |
| workspace-setup | "New workspace": the explorer session, its resume after a restart, the `workspace-rules` fragment | plugins/workspace-setup/README.md |
| conversation-view | the Chat and Log session views, `GET /api/sessions/:id/history`, the `log-card` slot | plugins/conversation-view/README.md |
| ↳ edit-cards | conversation-view feature: Edit/Write changes as cards in Chat and Log, grouped when several come in a row | plugins/conversation-view/edit-cards/README.md |
| ↳ git-cards | conversation-view feature: git operations in Bash calls as cards, with each commit's diff | plugins/conversation-view/git-cards/README.md |
| ↳ command-runs | conversation-view feature: `!` command cards (Run, queue, View script, ▶ Terminal) and the commands the user ran, with output | plugins/conversation-view/command-runs/README.md |
| ↳ permissions | conversation-view feature: answering a session's tool-permission menu (Yes / No…) from the prompt box, and Settings → Session permissions (allowlist for sessions the app starts) | plugins/conversation-view/permissions/README.md |
| ↳ questions | conversation-view feature: answering a session's AskUserQuestion forms from the prompt box | plugins/conversation-view/questions/README.md |
| menagerie | resident hosts you pick, generated for you (voice, lines, portrait, animations) in the Chat view and the sessions the app starts; off by default | plugins/menagerie/README.md |
| ↳ session-stats (built in) | tokens, API-equivalent cost and a Files changed modal under each session's header | builtin/session-stats/README.md |
| ↳ slash-picker | conversation-view feature: the prompt box's `/` command picker (`composer-addon` slot) | plugins/conversation-view/slash-picker/README.md |
| live-terminal | a session's Terminal view: live `claude attach` over a WebSocket, snapshot fallback | plugins/live-terminal/README.md |
| ↳ session-tools (built in) | Hand off, the Close session menu item (the route is core) and + New session (auto model/name); `handoff` and `new-session` jobs | builtin/session-tools/README.md |
| ↳ bash-snapshots | conversation-view feature: files changed by Bash commands as diff cards, via a git-snapshot hook, off unless the `bashSnapshots` setting is on | plugins/conversation-view/bash-snapshots/README.md |
| adversarial-review | multi-model review of a worktree or PR in the background, then one session to address it | plugins/adversarial-review/README.md |
| ↳ file-links | conversation-view feature: file paths in messages become links that open the file in a modal | plugins/conversation-view/file-links/README.md |
| ↳ app-rules (built in) | the rules the app's features rely on (`!` commands, scripts, follow-up questions), in every app-started session | builtin/app-rules/README.md |
| ticket-workflow | a bundled ticket-workflow Claude plugin (worktree layout, ticket notes, Jira defaults), app-started sessions only | plugins/ticket-workflow/README.md |
| keep-awake | keeps the machine from idle-sleeping while a session is working (`caffeinate -i`; Linux/Windows experimental; lid close still sleeps) | plugins/keep-awake/README.md |
| plugin-author | "Create plugin" in Settings → Plugins: describe a plugin, a session builds it in a new workspace (official or local) | plugins/plugin-author/README.md |
| session-awareness | sibling sessions share a derived per-workspace digest (claims, PRs, commits, edited files): in start prompts, a change-only hook, `wh claim`/`wh done`, Details → Sessions at a glance | plugins/session-awareness/README.md |
| auth | LAN access: token sign-in, device pairing, passkeys (off by default) | plugins/auth/README.md |
| scrutinize-pr | the PR page's Summary tab: a narrative guide to the PR written on demand and saved locally, how much changed since and an Update that folds in only the new commits, questions on any passage answered inline or folded into the guide; `/work-hub:scrutinize-pr [PR]` starts one from a session | plugins/scrutinize-pr/README.md |

## Commands

- `pnpm install`, then `pnpm dev`: API with `--watch` on 127.0.0.1:4848 and Vite with hot reload on
  http://127.0.0.1:4849.
- `pnpm build && pnpm start`: the production build, served at http://127.0.0.1:4848.
- `pnpm typecheck`, `pnpm test` (`node --test` over `server/`, `web/src/`, `plugins/` and `scripts/`). Both regenerate
  `web/src/plugins.generated.ts` first. Run all three before committing.
- `scripts/update.sh [--no-pull] [--no-restart]`: pull (skipped when the branch has no upstream), install, build, restart
  this checkout's launchd agents or, on Linux, systemd user units (not the terminal daemon).
- `scripts/setup-lan.sh --hostname <name> [--apply|--uninstall] [--with-term] [--adopt]`, `scripts/setup-auth.sh
  --hostname <name> [--apply] [--rotate]`: opt-in LAN access (Caddy front, agents, certificate; the sign-in token and
  link). Dry run by default. `-term` (the terminal daemon) only with `--with-term`; agents of plugins that are off are
  left alone.
- Scripts that change anything outside the repo are dry run by default with an explicit `--apply`; keep new ones so,
  non-interactive (flags and env only) and never printing secrets. Launchd labels use the prefix
  `${WORK_HUB_LAUNCHD_PREFIX:-com.<user>.work-hub}`, `<user>` being `$USER` with anything but `[A-Za-z0-9-]` turned into
  `-` (`LABEL_USER` in `scripts/lib/launchd.sh`, sourced by setup-lan.sh, setup-auth.sh, update.sh and the notes/code
  `install-agent.sh`). Launchd ownership: every plist they write has `EnvironmentVariables.WORK_HUB_REPO` = the
  checkout, and they never boot out, overwrite, delete or restart a label whose plist points at another checkout
  (`WORK_HUB_REPO`, else `WorkingDirectory`) unless `--adopt`; tested in `scripts/launchd.test.ts` against a temp
  `WORK_HUB_LAUNCH_AGENTS_DIR` and a fake `launchctl`. Keep any new launchd script on that library. On Linux the same
  scripts write systemd user units (`scripts/lib/service.sh`: `<label>.service` in `WORK_HUB_SYSTEMD_USER_DIR`, marked
  `Environment="WORK_HUB_REPO=…"`, `systemctl --user`), tested with `WORK_HUB_PLATFORM=Linux` and a fake `systemctl`;
  `scripts/trust-ca-linux.sh` is `trust-ca-mac.sh`'s twin.
- Stop a server you started by its pid (or by port with `lsof -t`), never by pattern: the user's own copy may run the
  same command line.
