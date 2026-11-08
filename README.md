# work-hub

One local page for your work: your Claude sessions (prompt them, answer their questions, see what they changed),
workspaces that tie a ticket or prompt to its worktrees, sessions and PRs, the PRs waiting on you, and the health of
the tools behind it all. Almost everything is a plugin you can switch off, replace, or add to with your own.

It runs on your Mac (or, experimentally, Linux or Windows) and listens on 127.0.0.1 only. It polls, and spends tokens,
only while a browser tab is visibly open and the machine is in use.

**Linux and Windows support is experimental.** It was built and tested on macOS: the Linux code passes the test suite
and a server smoke test in a container, but its setup scripts have never run against a real systemd, and the Windows
code (the ConPTY bridge, the named pipe, the PowerShell scripts in `scripts/windows/`) has never run on Windows. If
you're the first to set it up there, expect to fix things: please commit the fixes back, and update this note (and
`docs/windows.md`) with what you verified.

## Run it

The easy way: clone it, open Claude Code in the folder and say **"set this repo up"**. Or do it yourself:

```sh
git clone <this repo> work-hub && cd work-hub
scripts/setup.sh             # checks what's needed and says how to fix anything missing
scripts/setup.sh --apply     # installs, builds, and runs it in the background on http://127.0.0.1:4848
```

It needs Node 26, pnpm, git, python3 and the `claude` CLI (signed in); `gh` (signed in) for the GitHub features. The
background service (a launchd agent on macOS, a systemd user unit on Linux) starts it again at every login;
`scripts/update.sh` updates it after a `git pull`, and `scripts/setup.sh --uninstall` removes the service. To work on
it instead: `pnpm install && pnpm dev` (http://127.0.0.1:4849, hot reload; the API is on 4848).

Open the URL in a browser on the same machine. The first time, it asks where your repos are cloned and where worktrees
should go (defaults `~/repos` and `~/worktrees`); both stay editable in Settings → Folders, and the env vars
`WORK_HUB_REPOS_DIR` / `TW_WORKTREES_ROOT` still override them. There's no login in this mode: only this machine can reach it, which
means every process and every macOS account on this Mac can use it (and drive your Claude sessions). Turn on the auth
plugin with a hostname (`scripts/setup-lan.sh`) for anything wider.

## What you see

- **Workspaces** (front page): what you're working on, each with its ticket or prompt, status and Claude sessions,
  grouped by state. A workspace's page has its sessions and terminals as tabs, and Details (links, PRs, worktrees,
  plan, activity), Diff, Note and Code on the right. **New workspace** takes a ticket key or a prompt and starts a setup
  session that picks repos, creates worktrees, records them and writes a plan. CLI over the same data: `bin/wh`.
- **Sessions**: each has Terminal (live), Chat (readable, with cards for file changes, git operations and `!`
  commands) and Log (raw) views, a prompt box with a `/` picker, and its questions as forms. Sessions not in a
  workspace show as Unassigned.
- **PRs**: needs-your-review and your own, with checks, review state, conflicts and threads, an in-app preview
  (conversation, files, checks, merge), and a button to start a session on one.
- **Status**: plugins, data sources, sign-in checks and anything needing attention (also the dot in the header).
- **Settings**: per-device preferences (Low data for phones on cellular), and Plugins.
- **Keyboard**: ⌘K (Ctrl+K on Windows/Linux) jumps anywhere, `>` or ⇧⌘K for commands; press `?` or the header's ⌨
  for the full cheat sheet (`docs/keyboard-shortcuts.md`).

## Plugins

Settings → Plugins lists every plugin with a switch; a change applies after `pnpm build` and a restart. The official
ones live in `plugins/<id>/`, each with a README; the list is in `CLAUDE.md`. The app's own features (session tools,
health, session stats, app rules) are built in (`builtin/`), always on, with their options under Settings. Some are off by default because they need
setup (notes, code, auth, and conversation-view's `bashSnapshots` setting).

Your plugin config is `~/.config/work-hub/plugins.json` (or `$WORK_HUB_CONFIG_DIR/plugins.json`); it's never in the
repo, so pulling never conflicts with it. Missing means all defaults.

```json
{
  "local": ["/Users/you/my-work-hub-plugins/plugins"],
  "enabled": { "notes": true, "menagerie": false },
  "settings": {
    "github": { "jiraBaseUrl": "https://your-site.atlassian.net" },
    "notes": { "url": "http://127.0.0.1:18744/notes" }
  }
}
```

- `local`: folders of your own plugins (a plugin folder, or a folder of them). Writing one: `docs/plugins.md`.
- `enabled`: overrides a plugin's default.
- `settings`: per-plugin settings (each README lists its keys). An env var `WORK_HUB_<PLUGIN>_<KEY>` wins over them.

Core knobs (ports, dirs, intervals) are `WORK_HUB_*` env vars, listed in `server/config.ts`.

## Source control and plain folders

Workspaces use git by default, but they aren't limited to it. **New workspace** has a "More options" section with
Source control (Detect, or a specific one) and Folder, and a workspace can be a plain folder with no version control:
no setup session, just a place to work. Settings → Source control sets the default and Settings → Folders sets where
plain workspaces are made. Jujutsu, Mercurial and Perforce are experimental plugins, off by default: switch them on
in Settings → Plugins (applies after a rebuild and restart). A plain folder can be anywhere; outside work-hub's own
folders you confirm it once. The Diff tab and PR features are git-only. In a workspace's terminal,
`wh worktree add --vcs <id>` records a copy of another kind.

## Notes and code

The Note tab (SilverBullet) and Code tab (VS Code in the browser) need their own servers. Ask Claude to follow
`plugins/notes/setup/SETUP.md` or `plugins/code/setup/SETUP.md`: they install the tool, a loopback-only launchd agent
(a systemd user unit on Linux; dry run first), point the plugin at it and turn it on.

## Optional: LAN access (phone, other devices)

Off by default. It needs the `auth` plugin (token sign-in, passkeys) and a hostname you choose that resolves to this
Mac on your network. Node still listens on 127.0.0.1 only; a Caddy front serves the hostname over HTTPS.

1. `scripts/setup-lan.sh --hostname <name>`: an mkcert certificate (an existing valid one in `<state>/tls` is reused),
   a Caddy front serving `https://<name>` and launchd agents that run the app at login (plus the notes and code servers
   if those plugins are on; on Linux, systemd user units: see below). Dry run by default, `--apply` to install,
   `--uninstall` to remove. If the auth plugin is off, `--apply` turns it on in `plugins.json` (the dry run says so). It only replaces agents
   whose plist points at this checkout (`--adopt` takes over another checkout's), never touches the terminal daemon
   agent without `--with-term`, and leaves agents of plugins you've switched off alone.
2. When everything answers, `--apply` creates the sign-in token and copies a one-tap sign-in link to the clipboard (never
   printed; `--no-link` skips it). Later links: `scripts/setup-auth.sh --hostname <name> --apply`. Other devices:
   Settings → Other devices → **Sign in another device** shows a QR code. After signing in, the app offers **Add passkey**.
3. Every device must trust the mkcert root CA (the server offers it at `/ca.pem`, the certificate only). On the Mac:
   `scripts/trust-ca-mac.sh --hostname <name>`. Passkeys refuse sites with certificate warnings.

On Linux the same scripts write systemd user units (`~/.config/systemd/user/<label>.service`, logs in
`~/.local/state/work-hub/logs`) and copy the link with `wl-copy`, `xclip` or `xsel`. Packages: `apt install` /
`dnf install` `caddy mkcert jq` plus `libnss3-tools` / `nss-tools` for browsers. Caddy may only listen on 443 as you
after `sudo setcap cap_net_bind_service=+ep "$(command -v caddy)"` (again after each Caddy upgrade), or set
`WORK_HUB_PUBLIC_PORT=8443`. Trust the CA with `scripts/trust-ca-linux.sh --hostname <name> --apply` (`mkcert -install`;
run `sudo -v` first), and `loginctl enable-linger $USER` keeps the units running after you log out.

The server refuses to start with a hostname set and the auth plugin off. See `plugins/auth/README.md`.

## Updating

```sh
scripts/update.sh
```

Pulls (fast-forward only; skipped with a note when the branch has no upstream, or with `--no-pull`), installs, builds, and restarts the launchd agents (Linux: systemd user units) of this checkout you installed (label prefix
`com.<user>.work-hub` with `$USER`'s characters other than letters, digits and `-` turned into `-`, or
`$WORK_HUB_LAUNCHD_PREFIX`); without any, restart your `pnpm start`. It never restarts the
terminal daemon (that ends every shell) but tells you when it changed. Database migrations, including each plugin's,
run by themselves at startup. `--no-restart` only pulls and builds.

## Developing

`CLAUDE.md` describes the architecture, the plugin API and the rules every change follows (security, low data, mobile).
`CHANGELOG.md` has the plugin API versions. Checks: `pnpm typecheck && pnpm test && pnpm build`.

`@novnc/novnc` stays in `package.json` although no official plugin uses it: it's kept for local plugins that need it
(a local plugin can't add npm dependencies to the host build yet).
