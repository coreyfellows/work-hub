# ticket-workflow

A bundled copy of the **ticket-workflow** Claude Code plugin, adapted for work-hub, plus the small server plugin that
loads it into the sessions work-hub starts and tells the rest of the app where its scripts are. On by default.

## What's bundled (`claude/`)

| path | what |
| --- | --- |
| `.claude-plugin/plugin.json` | the Claude plugin manifest (name `ticket-workflow`) |
| `hooks/hooks.json` + `scripts/session-start.sh` | SessionStart hook: adds `policy.md` to the session's context (off with `TW_INJECT_POLICY=0`) |
| `policy.md` | the conventions, rewritten for work-hub: work-hub owns sessions; worktree layout `<root>/<repo>/<KEY>` (branch `f-<KEY>-<desc>`, then `trust-worktree.sh`); Jira tickets via `ticket-defaults`; ticket notes; model choice (haiku / sonnet / opus / fable for the hardest, longest-horizon work) |
| `scripts/config.sh` | every setting (`TW_*`), sourced by the other scripts; run it to print the effective values |
| `scripts/trust-worktree.sh` | marks worktrees under `TW_WORKTREES_ROOT` as trusted in `~/.claude.json`, so `claude --bg` starts there (work-hub sets `TW_WORKTREES_ROOT` and `WORK_HUB_REPOS_DIR` from Settings → Folders for every command and session it starts) |
| `scripts/ensure-ticket-note.sh` | creates `<TW_NOTES_DIR>/tickets/<KEY>.md` from a skeleton if missing; prints `<TW_NOTES_URL>/tickets/<KEY>` (default `/notes/...`, work-hub's own origin) or the path with `--path-only` |
| `skills/ticket-defaults` | Jira defaults: assignee, active sprint, "Starting work on a ticket" |
| `skills/ticket-notes` | keeping the ticket note up to date (scripts as `!` lines, manual steps, context) |
| `skills/setup` + `setup.sh` + `config.env.example` | writes work-hub's ticket-workflow config file and checks tools |

The app uses the scripts directly: the notes plugin runs `ensure-ticket-note.sh`; workspace-setup's explorer prompt
and `workspace-rules` fragment name `trust-worktree.sh`; the github plugin's PR sessions (and adversarial reviews,
through it) run `trust-worktree.sh` on new worktrees.

### Why a one-time copy

The standalone ticket-workflow repo stays the source of its author's everyday Claude setup and isn't synced with this
copy. This one is adapted for work-hub (no owner values, no terminal multiplexer, work-hub owns sessions) and changes
only here.

### Dropped from the standalone plugin

`spawn-ticket-session`, `end-session` and `ticket-pages` skills; the cmux scripts (`cmux-*`, `open-worktree-workspace`,
`open-ticket-pages`, `rearrange-ticket-pages`), `open-vscode-web`/`open-vscode-file`; the `install-*-agent.sh`
installers (the notes and code plugins' `setup/SETUP.md` guides take over); the `WorktreeCreate`/`WorktreeRemove` hooks
and their scripts. The policy's "one conversation per ticket" and "a new worktree gets its own session" rules are gone:
work-hub starts and records sessions itself (the core's workspace rules say how).

## Loading: only into sessions work-hub starts

`server.ts` adds launch args (`ctx.sessions.addLaunchArgs`) to every `claude --bg` the app starts (new workspace
explorer, + New session, handoff, PR sessions, review sessions): `--plugin-dir <this plugin>/claude`, which loads the
copy for that session only. Nothing is installed; the user's own Claude setup is untouched, and sessions they start
themselves don't get it.

**User-scope skip:** if the user already has a plugin named `ticket-workflow` installed **and enabled at user scope**,
the bundled copy is not added, so their own version stays in charge: with `--plugin-dir`, Claude Code (2.1.318) loads the
inline copy *instead of* an installed plugin of the same name (checked with a headless `claude -p` init event). The check is the core's
`ctx.claude.pluginInstalled('ticket-workflow', { scope: 'user', enabledOnly: true })` (`claude plugin list --json`), asked
on the first session start; a successful listing is cached for the server's life, while a failure loads the copy for
that session and is retried next time. Restart the server after installing or removing the user-scope plugin.
Project- or local-scope installs, and disabled or broken ones, don't count. (The app's own script calls still use the
bundled `scripts/` either way.)

## The scripts path (`ctx.paths.ticketWorkflowScripts`)

The plugin exposes `ctx.services.get('ticket-workflow')` = `{ scriptsDir, claudeDir }`, and the core's
`ctx.paths.ticketWorkflowScripts` resolves to `scriptsDir` while the plugin is loaded (it's a getter, read on use, so
load order doesn't matter). With the plugin off it's `WORK_HUB_TW_SCRIPTS` if set, else empty, and then:

- the explorer prompt and the `workspace-rules` fragment name the core's `<repoRoot>/bin/wh trust <path>` instead of
  `trust-worktree.sh` (same effect, `ctx.sessions.trustWorktree`);
- PR sessions (and adversarial reviews through them) trust new worktrees with `ctx.sessions.trustWorktree`;
- the notes plugin writes ticket notes' skeleton itself.

## Settings

The server plugin has none of its own. The scripts read, highest first:

1. the environment (`TW_*`);
2. work-hub's file: `$WORK_HUB_TW_CONFIG`, default `<work-hub config dir>/ticket-workflow.env` (the config dir is
   `WORK_HUB_CONFIG_DIR`, else `${XDG_CONFIG_HOME:-~/.config}/work-hub`). The server sets `WORK_HUB_TW_CONFIG` for
   its children when unset, so it follows the app's config dir;
3. a standalone ticket-workflow setup's `~/.config/ticket-workflow/config.env` (`$TICKET_WORKFLOW_CONFIG`), if present;
4. generic defaults (no Jira, `~/worktrees`, `~/notes`, notes at `/notes`).

`claude/scripts/config.sh` prints the effective values; `claude/setup.sh [--jira-base-url …] [--jira-project …]
[--jira-board-id …] [--jira-account-id …] [--worktrees-root …]` (or the `ticket-workflow:setup` skill in a session)
writes work-hub's file from `config.env.example`, every line commented out so the standalone file still shows through.
The variable names are the standalone plugin's (`TW_JIRA_*`, `TW_WORKTREES_ROOT`, `TW_NOTES_DIR`,
`TW_INJECT_POLICY`…), plus `TW_NOTES_URL`. Settings only the dropped scripts used (TLS, launchd, cmux layout) are kept
so a shared file parses the same, but nothing here reads them.

## Tests

`launch.test.ts`: the launch args (present when not installed, absent when installed) and `register()` (the check waits
for the first session and asks for an enabled user-scope install; the service). The listing parser and its cache are the
core's (`server/lib/claudePlugins.test.ts`).
