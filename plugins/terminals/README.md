# terminals

Shells on this machine in the browser, which keep running when you leave the page, reload, or restart or redeploy the
main server. They show on the Terminal page (`/terminal`) and as tabs in a workspace's tab strip. A `!` command card's
"▶ Terminal" button runs a script in a new workspace terminal, and its output and exit code are kept.

## How it works

- **Daemon** (`termd.ts`): the shells live in a separate process on a unix socket (default `<stateDir>/termd.sock`,
  mode 0600 in the 0700 state dir; on Windows the named pipe `\\.\pipe\work-hub-termd-<user>`, whose default ACL
  lets only you, SYSTEM and administrators write to it). Each shell runs in a pty through the core's
  `server/lib/ptybridge.py` (`$SHELL -l`, or `WORK_HUB_TERM_SHELL`; on Windows `pwsh.exe -NoLogo` if PowerShell 7 is
  installed, else Windows PowerShell, on ConPTY through pywinpty). It's mirrored into a headless xterm (5000 lines). On every attach the daemon first sends
  the serialized screen and scrollback, so a reload keeps the history.
  - Every 10s, and when the daemon exits, each history is saved to `<dir>/<id>.json` (0600). It can contain anything
    you typed or printed.
  - After a daemon restart, those histories come back as ended tabs with "New shell here".
  - The socket must sit in a private (0700) directory: anyone who can connect to it can type into your shells.
- `termd.ts` imports nothing from the app. It reads `WORK_HUB_TERMD_SOCKET`, `WORK_HUB_TERMS_DIR` and
    `WORK_HUB_TERMD_BRIDGE` from the env. Without them it uses `WORK_HUB_STATE_DIR` (else `$XDG_STATE_HOME/work-hub`).
- **Proxy** (`routes.ts`): the main server relays the routes below to the daemon, behind its sign-in.
- **Terminal runs** (`terminalRuns.ts`): "▶ Terminal" types `bin/wh-term-run <runId> <runsDir>` into a new terminal.
  - The run is a `command_runs` row with `via = 'terminal'` (core migration 6: `via`, `exit_code`, `term_id`).
  - The command goes in `<runsDir>/<id>.cmd`. It runs under script(1) (BSD's on macOS, util-linux's on Linux), so it
    still has a real tty. The output is logged to `<id>.log` and the exit code to `<id>.exit`. Git Bash on Windows has
    no script(1): the output is tee'd instead, and the line is typed as a PowerShell call to Git Bash (or as is, when
    the `shell` setting is a bash).
  - Once the exit file appears, the cleaned log (escapes stripped, CR overwrites applied, 512 KB cap) and the exit code
    go on the row, and the files are removed. Runs are watched for up to 6h; the watch resumes at startup.
  - The run also logs a `command-terminal` workspace event.
  - Claude doesn't see what a terminal prints.

## Starting the daemon

When the server is listening (`onStart`), if nothing answers on the socket and `autostart` is on (the default), the
plugin starts `node plugins/terminals/termd.ts` itself:

- Detached (its own process group), so it outlives the server. Its output goes to `<stateDir>/termd.log`; over 5 MB it is
  copied to `termd.log.1` (one generation) and emptied, when the plugin starts a daemon, when a daemon starts, and while
  it runs (checked on its 10-second save tick, at most one rotation an hour). The daemon rotates the file named by
  `WORK_HUB_TERMD_LOG`, which the plugin and the `-term` launchd agent set.
- If something already holds the socket, `termd.ts` exits instead of taking it over: it exits 0 when another termd
  answers, and 1 when the probe times out or gets an odd reply. Only a missing or stale (ECONNREFUSED) socket is
  replaced. The plugin's own check uses the same rule, so two servers starting together end up with one daemon.
- It gets the server's env minus `NODE_ENV`, plus the socket, dir and bridge paths the plugin resolved. The plugin logs
  its pid.
- **Restarting the daemon ends every shell.** Only restart it when `termd.ts` changes: stop that process (by its pid),
  then reload any page or restart the server.

Optional: run it under launchd (or a systemd user unit on Linux, a Scheduled Task on Windows; the setup scripts write
those the same way) instead, so it starts at login. Set `autostart` to false, or leave it on: it does nothing
while the socket answers. A user agent such as `~/Library/LaunchAgents/<your.label>.work-hub-term.plist` would have:

- `ProgramArguments`: `<node> <repo>/plugins/terminals/termd.ts`.
- `WorkingDirectory`: the repo.
- `EnvironmentVariables`: `WORK_HUB_REPO` (the repo: the setup scripts only touch plists that point at their own
  checkout), `PATH`, `LANG`, and `WORK_HUB_STATE_DIR` / `WORK_HUB_TERMD_SOCKET` if you changed them.
- `RunAtLoad` true.

Don't make it `KeepAlive`-restarted by the main server's deploys. `scripts/setup-lan.sh --with-term` writes one like this (`<prefix>-term`) when `autostart` is false; without
`--with-term` it never touches that label (replacing it ends every shell).

## Routes

| route | what |
| --- | --- |
| `GET /api/terms` | terminals that belong to no workspace (ETag-revalidated) |
| `POST /api/terms` `{cols, rows}` | a new one in `~` |
| `GET /api/workspaces/:id/terms` | the workspace's terminals (ETag-revalidated) |
| `POST /api/workspaces/:id/terms` `{cols, rows, cwd?, run?, sessionId?}` | a new one in one of the workspace's folders (`sessionDirs`: its worktrees, then the worktrees root; anything else is a 400). With `run` + `sessionId`, runs that script as a terminal run and answers with `runId` too |
| `POST /api/terms/:id/{close,restart,rename}` | `rename` takes `{title}` |
| WS `/api/terms/:id/ws?cols&rows` | attach. The Origin must be one the app is served at (`isAcceptedOrigin`). The first frame is binary (screen + scrollback), then live output. You send `{t:'in',d}` / `{t:'resize',cols,rows}`; it sends `{t:'exit'}` / `{t:'restarted'}` |

The terminal size is shared: the last resize wins for every attached client.

## Service

`ctx.services.expose('terminals', { runInTerminal(workspaceId, cwd, command, opts?) })`, typed `TerminalsService` in
`routes.ts`:

- It opens a terminal in `cwd`, one of the workspace's folders (empty means the first), and types the command and Enter.
- With `opts.sessionId`, the command goes through `bin/wh-term-run` and the result has `runId`.
- It throws `TerminalRequestError` (`status` 400/404) for bad input.
- `POST /api/workspaces/:id/terms` with `run` uses this service. It's meant for the command-runs plugin's "▶ Terminal".

## Slots

- `page` `/terminal`: nav "Terminal" (secondary, under More), `TerminalPage.tsx`. The tab you were on is kept in
  localStorage `wh.terminal.active`. On the first visit with no terminals, it opens one.
- `workspace-tab-kind` `terminals` (prefix `t-`): the workspace's terminals as tabs (`TermTab`) and the main pane
  (`TermPane`).
  - The picked tab is kept per workspace in `wh.ws.<id>.term`.
  - Its `menu` puts "New terminal" (a submenu of worktrees when there are several) in the strip's + menu, right after
    "New session".
  - `after` shows the "as of" age in low data.
  - `wrapSession` provides `TerminalRunContext`, so a session's `!` cards get "▶ Terminal". Without this plugin they
    have no Terminal button.
- Shared UI is in `Terminals.tsx` (`useTerms`, `TermTabs`, `TermTab`, `TermPane`, `guessSize`) and `ShellTerminal.tsx`
  (xterm.js and a key bar for phones). The tab chrome classes (`.term-tab*`) stay in the core's CSS, because session
  tabs use them too.

Low data: the lists don't poll and show `<AsOf>` (tap to refresh). A terminal connects only while it's open.

## Settings

Read with `ctx.config.get`: env `WORK_HUB_TERMINALS_<KEY>`, or plugins.json `settings.terminals.<key>`. The old env
names still work as defaults. The ones below marked **Settings** are declared in the manifest, so Settings → Terminals
edits them (stored in the app's database, under the env var and plugins.json); they are read for each new terminal, so a
change applies to the next one with no app restart.

| key | default | what it does |
| --- | --- | --- |
| `shell` (**Settings**) | your login shell | The program new terminals run (absolute path to an executable file; anything else is ignored). |
| `shellArgs` (**Settings**) | `-l` | Its arguments, split on spaces. Empty = a plain shell. |
| `startDir` (**Settings**) | home | Where terminals in the Terminal tab start (`~/…` ok). Workspace terminals start in the workspace's folder. |
| `startupCommand` (**Settings**) | none | Typed with Enter into every new terminal (not into ▶ Terminal script runs). |
| `scrollback` (**Settings**) | 5000 | Lines of history a new terminal keeps and restores (500 to 100000). |
| `autostart` (**Settings**) | on | Start the daemon with the app; read once at startup. |

The shell, arguments and scrollback travel in the create request to the daemon (`POST /terms`: `shell`, `shellArgs`,
`scrollback`) and are saved with each terminal, so a "new shell" on a restored one runs the same program. A daemon that
predates them ignores the fields: it takes effect when the daemon is next restarted (which ends every shell).


| key | default | old env |
| --- | --- | --- |
| `socket` | `<stateDir>/termd.sock` (Windows: `\\.\pipe\work-hub-termd-<user>`) | `WORK_HUB_TERMD_SOCKET` |
| `dir` (saved histories) | `<stateDir>/terms` | `WORK_HUB_TERMS_DIR` |
| `runsDir` (terminal-run files) | `<stateDir>/term-runs` | `WORK_HUB_TERM_RUNS_DIR` |
| `autostart` | `true` | |

A daemon that the plugin starts gets `socket` and `dir`. A launchd one reads its own env, so keep the two in agreement.
