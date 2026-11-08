# claude-monitor ("Claude Code updates")

Keeps the installed Claude Code current and turns its release notes into plugin work.

- **Newer version out**: a banner under the header says so ("Claude Code 2.1.320 is out (you have 2.1.319)") with
  **What's new** and **Update**. Update runs `claude update` as a background job (header tray); when it finishes in this
  tab, What's new opens. ✕ hides the offer on this device until an even newer version appears. Nothing installs
  without the click.
- **Installed version changed** (by Update, or by Claude Code's own auto-update): a "Claude Code is now X" banner with
  **What's new**. Closing the modal (or ✕) marks the version seen.
- **What's new** (modal; also the ⌘K command "Claude Code: what's new" and the plugin's settings page): the release
  notes from the last version you saw up to the newest known one (installed, or on npm), newest first.
- **Suggest plugin updates** (in the modal, only when you click it): one headless `claude -p` run (no tools) reads the
  release notes against each active official and local plugin's README (plus its feature READMEs, e.g.
  conversation-view's), and suggests which items each plugin could use: a new capability, a changed format or
  behaviour it depends on, a fix that removes a workaround. Each plugin is only asked about versions newer than its
  **baseline** (below). The answer is filtered in code: unknown plugins, versions outside a plugin's range, empty or
  duplicate items are dropped, six items per plugin at most.
- **Pick plugins**: tick the ones to update and press **Update n and skip the rest**, or **Skip all**. Each ticked
  plugin gets its own workspace ("Claude 2.1.320: <plugin>"), a work-hub worktree `claude-2-1-320-<plugin>` (branch of
  the same name, based like plugin-author's: the checkout's upstream when it has nothing the upstream lacks, else its
  branch) and an `opus` session told what to change, to set `"claudeVersion"` in the plugin's `plugin.json`, to run the
  checks, commit by the repo's rules and ask before going live. A local plugin's folder is passed with `--add-dir`; the
  worktree is then only for a core change. Unticked plugins are recorded as skipped for that version.

## Baselines: what's already been looked at

A plugin's baseline is the newer of:

- its manifest's `claudeVersion` (an optional plugin.json field, plugin API addition of 2026-11-08): the Claude Code
  version an update session last brought it up to. Tracked in the plugin's repo, so it's shared across machines.
- the local record (table `claude_monitor_plugins`): `seen` (the installed version when the monitor first saw the
  plugin, so a new plugin isn't asked about the whole history), `skipped`, or `updating` (a session was started). A
  record never moves backwards.

Settings → Plugins → Claude Code updates → Settings lists every plugin's baseline and where it comes from.

## Routes

| route | what |
| --- | --- |
| `GET /api/plugins/claude-monitor/whats-new?from=&to=` | `WhatsNew`: release notes in `(from, to]` (defaults: last seen or installed → newest known); the current version's own notes when the range is empty (ETag) |
| `GET /api/plugins/claude-monitor/suggestions` | `{ analysis }`: the latest analysis (ETag) |
| `GET /api/plugins/claude-monitor/plugins` | `{ plugins: PluginRow[] }`: baselines (ETag) |
| `POST /api/plugins/claude-monitor/check` | ask npm now and refresh the source |
| `POST /api/plugins/claude-monitor/seen` | `{ version }`: What's new seen up to it |
| `POST /api/plugins/claude-monitor/update` | `202 { jobId }`: `claude update` job (`claude-update`); 409 while one runs |
| `POST /api/plugins/claude-monitor/analyze` | `202 { jobId }`: the suggestion job (`claude-monitor-analyze`); 409 while one runs |
| `POST /api/plugins/claude-monitor/apply` | `{ version, update: [ids], skip: [ids] }`: skips recorded at once; updates start in a job (`claude-monitor-apply`, `202 { jobId }`); 409 if `version` isn't the latest analysis |

## Source

`claude-monitor` (not `local`: it only runs while the app is watched): `MonitorData` (`installed`, `latest`, `channel`,
`updateAvailable`, `acknowledged`, `whatsNew`, `checkedAt`, `checkError`, `updating`, `analysis` status). Every 30
minutes it re-reads `claude --version`; npm's dist-tags (a few hundred bytes) at most every `checkHours`, or on ↻ / the
"check for updates" command. On the first run the installed version counts as seen.

## Slots

`app-banner` (the banner and the modal), `settings-section` (Versions, on the plugin's settings page),
`palette-commands` ("Claude Code: what's new", "Claude Code: check for updates"), `job-kind` (the three jobs).

## Settings

| key | env | default | what |
| --- | --- | --- | --- |
| `channel` | `WORK_HUB_CLAUDE_MONITOR_CHANNEL` | `auto` | npm dist-tag to compare: `auto` follows Claude Code's `autoUpdatesChannel` (`latest` unless `stable`), or `latest` / `stable` |
| `checkHours` | `WORK_HUB_CLAUDE_MONITOR_CHECK_HOURS` | `6` | hours between npm checks |
| `analysisModel` | `WORK_HUB_CLAUDE_MONITOR_ANALYSIS_MODEL` | `sonnet` | model of the suggestion run |
| `updateModel` | `WORK_HUB_CLAUDE_MONITOR_UPDATE_MODEL` | `opus` | model of the plugin update sessions |
| `changelogUrl` | `WORK_HUB_CLAUDE_MONITOR_CHANGELOG_URL` | the GitHub raw `CHANGELOG.md` | where release notes come from |
| `registryUrl` | `WORK_HUB_CLAUDE_MONITOR_REGISTRY_URL` | npm's dist-tags for `@anthropic-ai/claude-code` | where the newest version comes from |

## Caveats

- The changelog (about 1 MB) is fetched only when the cached copy lacks a version we need, at most every 10 minutes,
  into the plugin's cache dir; without a network it falls back to Claude Code's own `~/.claude/cache/changelog.md`
  (`CLAUDE_CONFIG_DIR` respected). The browser only gets the sections it shows, when the modal opens.
- Suggestions only cover what's installed: update first to get ideas for a newer version.
- The suggestion run sends up to ~120k characters of release notes (oldest versions dropped past that, and the modal
  says how many) plus ~3k of README per plugin: one call, sonnet by default.
- Built-in features (`builtin/`) aren't offered; only official and local plugins that are active.
- `claude update` with a package-manager install updates through that manager (Claude Code's own behaviour). Running
  sessions keep their version until restarted.
- Low data: the source is tiny and rides SSE deltas; the modal fetches the notes and suggestions only when opened.
- Starting update sessions creates real worktrees, workspaces and sessions: the routes aren't exercised by the tests
  (the pure parts are: versions, changelog parsing and loading, baselines, prompt, filter, store, banner logic).
