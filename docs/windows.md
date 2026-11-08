# Running work-hub on Windows

> **Experimental: none of this has run on Windows yet.** It was written on a Mac; the PowerShell scripts parse with
> PowerShell 7.4 and the TypeScript is covered by tests that fake Windows, nothing more. Whoever sets it up first: fix
> what breaks, commit it back, and replace this note with what you verified.

work-hub runs natively on Windows (no WSL2 needed). The server binds 127.0.0.1 only, as everywhere. The setup and
maintenance scripts have PowerShell twins under `scripts/windows/` (Windows PowerShell 5.1 and PowerShell 7). They
follow the same rules as the bash ones: dry run by default, an explicit `-Apply`, no prompts, secrets never printed.

## Prerequisites

- **Node 26**: `winget install OpenJS.NodeJS` (check `node --version`).
- **pnpm**: `npm install -g pnpm` (or `corepack enable`).
- **Git for Windows**: `winget install Git.Git`. Claude Code's Bash tool needs its Git Bash, and the terminals plugin
  types `!` commands through `bash.exe`.
- **Python 3** with **pywinpty** (the pty bridge uses ConPTY through it): `winget install Python.Python.3.12`, then
  `pip install pywinpty`. Set `WORK_HUB_PYTHON` if `python` isn't the right one.
- **gh**: `winget install GitHub.cli`, then `gh auth login`.
- **claude**: Claude Code, signed in.
- For LAN access only: **Caddy** (`winget install CaddyServer.Caddy`) and **mkcert** (`winget install FiloSottile.mkcert`,
  then `mkcert -install`; its CA lives in `mkcert -CAROOT`, by default `%LOCALAPPDATA%\mkcert`).

## First run

```powershell
pnpm install; pnpm build; pnpm start
```

Then open http://127.0.0.1:4848. State is in `%USERPROFILE%\.local\state\work-hub` (`WORK_HUB_STATE_DIR`), config in
`%USERPROFILE%\.config\work-hub` (`WORK_HUB_CONFIG_DIR`), as on macOS and Linux.

## Scripts

Run each as `powershell -NoProfile -ExecutionPolicy Bypass -File <script> …` (or `pwsh -File …`). `Get-Help <script>
-Full` shows its details.

| Script | What it does |
| --- | --- |
| `scripts\windows\update.ps1 [-NoPull] [-NoRestart] [-Prefix P]` | pull (skipped with no upstream), `pnpm install`, `pnpm build`, restart this checkout's tasks except `-term` |
| `scripts\windows\setup-lan.ps1 -Hostname <name> [-Apply \| -Uninstall] [-WithTerm] [-Adopt] [-NoLink]` | LAN access: node, Caddy and (if their plugins are on) notes/code as Scheduled Tasks, a mkcert certificate, the auth plugin on |
| `scripts\windows\setup-auth.ps1 -Hostname <name> [-Port N] [-Apply] [-Rotate] [-Adopt]` | the sign-in token; the one-tap sign-in link goes to the clipboard (`Set-Clipboard`), never printed |
| `scripts\windows\trust-ca.ps1 -Hostname <name> \| -Remove` | trust the mkcert CA in your user Root store (`certutil -user -addstore Root`, one Windows dialog), then check the served certificate |
| `scripts\windows\share-ca.ps1` | copy `rootCA.pem` (never the key) to Downloads and select it in Explorer, to send to a phone |
| `scripts\windows\restart-agent.ps1 -Label <name> [-Apply] [-Adopt]` | restart one task (what update.ps1 prints for `<prefix>-term`) |
| `plugins\notes\setup\install-agent.ps1 [-Apply \| -Uninstall] [-Port N] [-NotesDir D] [-Bin P]` | SilverBullet for the notes plugin, on 127.0.0.1 |
| `plugins\code\setup\install-agent.ps1 [-Apply \| -Uninstall] [-Port N] [-TokenFile F] [-Cli P]` | VS Code `serve-web` for the code plugin, on 127.0.0.1 |

**Background agents** are Scheduled Tasks for your user in the Task Scheduler folder `\work-hub\`, started at logon,
hidden, no time limit, restarted on failure, named like the macOS labels (`com.<user>.work-hub[-tls|-notes|-code|-term]`,
prefix `WORK_HUB_LAUNCHD_PREFIX`). Each runs `<state>\agents\<label>.cmd` (generated: environment, then the program,
started again if it exits) through `conhost.exe --headless`, with output in `<state>\logs\<label>.log`. The task's
Description holds `WORK_HUB_REPO=<checkout>`: a task of another checkout is never stopped, replaced or removed without
`-Adopt`. No admin rights needed.

**Firewall:** Caddy is the only thing listening on the LAN. The first time it does, Windows Firewall asks whether to
allow it; allow Private networks. To allow it up front, the `setup-lan.ps1` dry run prints a `New-NetFirewallRule` line
to run from an elevated PowerShell (the script never runs it).

**Terminal daemon:** listens on the named pipe `\\.\pipe\work-hub-termd-<user>` instead of a socket file.

## Untested

None of this has been run on Windows yet: the scripts were written against the macOS ones and reviewed by hand, but not
executed or even parsed by PowerShell. In particular, check:

- registering an at-logon task without elevation, and creating the `\work-hub\` task folder as a standard user;
- `conhost.exe --headless` keeping the agents windowless (Windows 10 1809 or later), and stopping a task ending its
  whole process tree (the scripts also stop the launcher's child processes by pid);
- `icacls` restricting the state dir, the TLS key and the tokens to your user;
- the certificate check (`X509Certificate2` on mkcert's PEM, the SAN match) and the TLS 1.2 trust check in `trust-ca.ps1`;
- Caddy on port 443 alongside anything else on the PC that holds it (IIS, other proxies).
