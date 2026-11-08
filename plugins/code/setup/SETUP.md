# Setting up code (VS Code serve-web)

A guide for a Claude session to follow end to end on the user's Mac. It makes sure the VS Code CLI is there, keeps
`code serve-web` running with a launchd agent on loopback, points the `code` plugin at it, turns the plugin on and
checks it works. Ask the user before each step that changes their machine (installing VS Code, `--apply`), and show
them the dry run first.

Every value below is a default the user can change: the port (`18743`), the token file
(`~/.local/state/vscode-serve-web.token`), the label prefix (`com.$USER.work-hub`). Use the same values in every step.

## 1. Prerequisites

- macOS or Linux (the agent script writes a launchd agent, or on Linux a systemd user unit; elsewhere run the command
  it prints under your own supervisor).
- work-hub cloned, `pnpm install` done, and it runs (`pnpm build && pnpm start`, or the user's launchd agent).
- Know whether the user has LAN access on (the `auth` plugin plus `scripts/setup-lan.sh`). It decides the URL in step 5.
- Pick a port nobody listens on: `lsof -nP -iTCP:18743 -sTCP:LISTEN` should print nothing.

## 2. Install the VS Code CLI

`serve-web` is a subcommand of VS Code's CLI. The script looks for it in this order:
`/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel`, then `code-tunnel` and `code` on the PATH.
Check: `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel" serve-web --help` lists
`--server-base-path` and `--connection-token-file`.

If it's missing, install VS Code (https://code.visualstudio.com/download, or `brew install --cask visual-studio-code`),
or the standalone CLI from the same page ("CLI" for macOS) and pass its path with `--cli`. The first start downloads the
VS Code server, so it needs network access once.

## 3. The connection token

serve-web refuses requests without a secret connection token. The script creates one (random, mode 0600) in the token
file if it's missing, and never prints it. work-hub reads that file on each request and puts the token only in the
links it hands its own UI (with LAN access, only to signed-in users). Don't paste the token anywhere, and don't
`cat` it into the conversation.

## 4. Install the launchd agent

`plugins/code/setup/install-agent.sh` (run from the repo root). Dry run first; it prints the plist it would write and
any problem (CLI missing, port taken):

```sh
plugins/code/setup/install-agent.sh
```

Values come from a flag, else its env var, else `plugins.json` `settings.code` (step 5), else the default: `--port N`
(`WORK_HUB_CODE_LOCAL_PORT`, `localPort`), `--token-file FILE` (`WORK_HUB_CODE_VSCODE_TOKEN_FILE`, `vscodeTokenFile`),
`--cli PATH` (`WORK_HUB_CODE_CLI`, `cli`), `--prefix P` (`WORK_HUB_LAUNCHD_PREFIX`). Prefer putting anything
non-default in `plugins.json` (step 5) over flags: `scripts/setup-lan.sh` reads the same settings and writes the same
agent, so the two never disagree. When the dry run looks right, ask the
user, then run it again with `--apply`. It creates the token if needed, writes
`~/Library/LaunchAgents/<prefix>-code.plist`, starts it and waits until the port answers. Log:
`~/Library/Logs/work-hub/<prefix>-code.log`. On Linux: `~/.config/systemd/user/<prefix>-code.service`
(`systemctl --user`), log `~/.local/state/work-hub/logs/<prefix>-code.log`; `loginctl enable-linger $USER` keeps it
running after logout. It's idempotent; `--uninstall` removes the agent and keeps the token file.

serve-web then answers at `http://127.0.0.1:<port>/code`, bound to loopback only.

## 5. Point the app at it

Settings live in `plugins.json` in work-hub's config dir (`$WORK_HUB_CONFIG_DIR`, default `~/.config/work-hub`). Create
it if it's missing and keep anything already there; only add or change the `code` entry under `settings`:

- **Localhost only** (the default; the app is opened at `http://127.0.0.1:4848`): the loopback URL.

  ```json
  { "settings": { "code": { "url": "http://127.0.0.1:18743/code" } } }
  ```

- **LAN access on**: leave `url` unset (its default is `/code`, same origin). With the plugin on (step 6),
  `scripts/setup-lan.sh --hostname <name>` routes `/code*` to `127.0.0.1:<localPort>` only after work-hub's sign-in
  check (`forward_auth` to `/auth-check`), and installs this same `<prefix>-code` agent itself from the settings below
  (it needs the token file to exist: run this guide's step 4 first). Run its dry run, then `--apply`, again after
  turning the plugin on.

Anything not at its default goes in the same entry: `"localPort": 18743`, `"vscodeTokenFile": "/abs/path"`,
`"cli": "/abs/path/to/code-tunnel"`. Env vars `WORK_HUB_CODE_<KEY>` win over `plugins.json`. All settings are in `plugins/code/README.md`.

## 6. Turn the plugin on

In the app: Settings → Plugins → switch **Code** on → Save. Or add `"enabled": { "code": true }` to the same
`plugins.json`. Either way it applies after a rebuild and restart: `pnpm build`, then restart the server (stop and rerun
`pnpm start`, or `scripts/update.sh` restarts the user's launchd agents; with `pnpm dev`, restart it).

## 7. Verify

- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18743/code/` prints `403` (no token: it's
  guarding), not a connection error.
- Status page → Plugins lists **code** as active.
- Open a workspace with a recorded worktree → the **Code** tab shows VS Code on that folder (a picker when there are
  several); "Open ↗" opens it in a tab. "No worktrees recorded…" means the workspace has none yet; no links at all
  usually means the token file is missing or empty.
- If the frame stays blank: check the agent log and the `url` setting (it must include `/code`).

## Undo

`plugins/code/setup/install-agent.sh --uninstall`, switch the plugin off in Settings → Plugins, remove `settings.code`
from `plugins.json`, and delete the token file if you want a new one next time.
