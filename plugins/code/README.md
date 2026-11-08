# code

VS Code (serve-web) for each of a workspace's worktrees, embedded in the workspace page as its **Code** tab. Off by
default: it needs a VS Code serve-web server, on loopback or behind work-hub's own origin (see Setup).

## What it does

- `codeLinks(ws, opts)` (`code.ts`): one link per recorded worktree, labelled `<repo name>@<branch>`, pointing at
  `<url>/?tkn=<token>&folder=<worktree path>`. The connection token is read from `vscodeTokenFile` on every request and
  only ever sent to a signed-in work-hub user; no token (missing or empty file) = no links.

## Routes

- `GET /api/plugins/code/workspaces/:id` → `CodeLink[]` (`{ label, path, url }`; 404 for an unknown workspace). Was the
  `code` half of the core's old `GET /api/workspaces/:id/tools`.

## Slots

- `workspace-panel` `code` ("Code", `wide`, order 102: after Diff and Note): a worktree picker when there are several
  (else the label), "Open ↗" and VS Code in an iframe (clipboard allowed); "No worktrees recorded for this workspace yet."
  when there are no links. It loads its route once, when the tab is first opened (panels stay mounted after that), so
  nothing polls; Low data needs nothing more. The `.tool-*` classes it uses are the core's (shared with Diff and Note).

## Settings

Read with `ctx.config.get`: env `WORK_HUB_CODE_<KEY>` first, then `plugins.json` `settings.code.<key>`.

| key | env | default | what |
| --- | --- | --- | --- |
| `url` | `WORK_HUB_CODE_URL` | `/code` | where serve-web is served (its `--server-base-path`, behind LAN access; `http://127.0.0.1:<port>/code` on localhost) |
| `vscodeTokenFile` | `WORK_HUB_CODE_VSCODE_TOKEN_FILE` | `$TW_VSCODE_TOKEN_FILE`, else `~/.local/state/vscode-serve-web.token` | serve-web's connection token |

Read only by the setup scripts (`setup/install-agent.sh`, `scripts/setup-lan.sh`), not the plugin: `localPort` (18743) and `cli` (the VS Code CLI).

## Setup

Follow `setup/SETUP.md` (written for an agent to follow end to end). VS Code serve-web runs as its own server:
`--server-base-path /code`, the connection token in `vscodeTokenFile`, bound to 127.0.0.1, kept running by a launchd
agent from `setup/install-agent.sh` (dry run by default, `--apply`, `--uninstall`; it creates the token if missing).

- **Localhost only** (the default): set `url` to `http://127.0.0.1:<port>/code` and the Code tab frames it directly.
- **LAN access** (the `auth` plugin plus `scripts/setup-lan.sh`): leave `url` at `/code`. The front proxy sends `/code*`
  to serve-web only after `forward_auth` to work-hub's `/auth-check` (signed in, else a redirect to `/login`). Same
  origin means anything running in VS Code (extensions) can call work-hub's API as you.
