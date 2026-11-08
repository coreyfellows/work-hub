# Setting up notes (SilverBullet)

A guide for a Claude session to follow end to end on the user's Mac. It installs SilverBullet, keeps it running with a
launchd agent on loopback, points the `notes` plugin at it, turns the plugin on and checks it works. Ask the user
before each step that changes their machine (installing a binary, `--apply`), and show them the dry run first.

Every value below is a default the user can change: the port (`18744`), the notes folder (`~/notes`), the label prefix
(`com.$USER.work-hub`). Use the same values in every step.

## 1. Prerequisites

- macOS or Linux (the agent script writes a launchd agent, or on Linux a systemd user unit; elsewhere run the command
  it prints under your own supervisor).
- work-hub cloned, `pnpm install` done, and it runs (`pnpm build && pnpm start`, or the user's launchd agent).
- Know whether the user has LAN access on (the `auth` plugin plus `scripts/setup-lan.sh`). It decides the URL in step 4.
- Pick a port nobody listens on: `lsof -nP -iTCP:18744 -sTCP:LISTEN` should print nothing.

## 2. Install SilverBullet

Check first: `command -v silverbullet || ls ~/.local/bin/silverbullet`. If it's there, run `silverbullet --version` and
go to step 3.

Otherwise download the server build for this Mac from https://github.com/silverbulletmd/silverbullet/releases (the
latest release's `silverbullet-server-darwin-aarch64.zip` on Apple silicon, `-x86_64` on Intel), unzip it and put the
`silverbullet` binary in `~/.local/bin` (create it if needed; `chmod +x`). If macOS quarantines it, run
`xattr -d com.apple.quarantine ~/.local/bin/silverbullet`. Check: `~/.local/bin/silverbullet --help` lists `--single`.

No token is needed: SilverBullet runs without its own login because it listens on 127.0.0.1 only (and, with LAN
access, behind work-hub's sign-in).

## 3. Install the launchd agent

`plugins/notes/setup/install-agent.sh` (run from the repo root). Dry run first; it prints the plist it would write and
any problem (binary missing, port taken):

```sh
plugins/notes/setup/install-agent.sh
```

Values come from a flag, else its env var, else `plugins.json` `settings.notes` (step 4), else the default: `--port N`
(`WORK_HUB_NOTES_LOCAL_PORT`, `localPort`), `--notes-dir DIR` (`WORK_HUB_NOTES_NOTES_DIR`, `notesDir`), `--bin PATH`
(`WORK_HUB_NOTES_SILVERBULLET`, `silverbullet`), `--prefix P` (`WORK_HUB_LAUNCHD_PREFIX`). Prefer putting anything
non-default in `plugins.json` (step 4) over flags: `scripts/setup-lan.sh` reads the same settings and writes the same
agent, so the two never disagree. When the dry run looks right, ask the user,
then run it again with `--apply`. It creates the notes folder if missing, writes
`~/Library/LaunchAgents/<prefix>-notes.plist`, starts it and waits until the port answers. Log:
`~/Library/Logs/work-hub/<prefix>-notes.log`. On Linux: `~/.config/systemd/user/<prefix>-notes.service`
(`systemctl --user`), log `~/.local/state/work-hub/logs/<prefix>-notes.log`; `loginctl enable-linger $USER` keeps it
running after logout. It's idempotent (run it again after changing a flag); `--uninstall`
removes the agent and leaves the notes alone.

SilverBullet then serves the folder at `http://127.0.0.1:<port>/notes`, with shell commands off.

## 4. Point the app at it

Settings live in `plugins.json` in work-hub's config dir (`$WORK_HUB_CONFIG_DIR`, default `~/.config/work-hub`). Create
it if it's missing and keep anything already there; only add or change the `notes` entry under `settings`:

- **Localhost only** (the default; the app is opened at `http://127.0.0.1:4848`): the loopback URL.

  ```json
  { "settings": { "notes": { "url": "http://127.0.0.1:18744/notes" } } }
  ```

- **LAN access on**: leave `url` unset (its default is `/notes`, same origin). With the plugin on (step 5),
  `scripts/setup-lan.sh --hostname <name>` routes `/notes*` to `127.0.0.1:<localPort>` only after work-hub's sign-in
  check (`forward_auth` to `/auth-check`), and installs this same `<prefix>-notes` agent itself from the settings below.
  Run its dry run, then `--apply`, again after turning the plugin on.

Anything not at its default goes in the same entry: `"localPort": 18744`, `"notesDir": "/abs/path"`,
`"silverbullet": "/abs/path/to/silverbullet"`. Env vars `WORK_HUB_NOTES_<KEY>` (e.g. `WORK_HUB_NOTES_NOTES_DIR`) win
over `plugins.json`. Notes for ticket workspaces are made by the ticket-workflow
plugin's `ensure-ticket-note.sh`; if that script isn't where the plugin looks, set `ticketWorkflowScripts`. All settings
are in `plugins/notes/README.md`.

## 5. Turn the plugin on

In the app: Settings → Plugins → switch **Notes** on → Save. Or add `"enabled": { "notes": true }` to the same
`plugins.json`. Either way it applies after a rebuild and restart: `pnpm build`, then restart the server (stop and rerun
`pnpm start`, or `scripts/update.sh` restarts the user's launchd agents; with `pnpm dev`, restart it).

## 6. Verify

- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18744/notes/` prints `200`.
- Status page → Plugins lists **notes** as active (not skipped; a skip says why).
- Open a workspace → the **Note** tab shows its note (or a "Create note" button for one made before the plugin was on);
  "Open ↗" opens it in SilverBullet. A new workspace gets its note on creation (logged as a `note` event).
- If the tab is blank: check the agent log, the `url` setting (it must include `/notes`), and that it matches the mode
  (the loopback URL for localhost, `/notes` behind LAN access).

## Undo

`plugins/notes/setup/install-agent.sh --uninstall`, switch the plugin off in Settings → Plugins, and remove
`settings.notes` from `plugins.json`. The notes folder is never deleted.
