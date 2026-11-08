# Linux and Windows support

work-hub was written on and for macOS. This change gives every macOS-specific piece a Linux and a native Windows
alternative, keeping macOS behaviour exactly as it is. The owner chose fully native Windows (no WSL2 requirement).

## Goals

- The server, `bin/wh`, the live terminal, typing into sessions and the terminals plugin run on macOS, Linux and
  Windows.
- Every setup/maintenance script that manages background agents, certificates or the clipboard has a Linux path (same
  bash script, a systemd user-unit backend) and a Windows path (a PowerShell script under `scripts/windows/` or beside
  the bash one as `<name>.ps1`).
- Same safety rules on every platform: loopback-only node, dry run by default with an explicit apply flag, fully
  non-interactive, never print secrets, never touch an agent/unit/task that points at another checkout unless adopting.

## Non-goals

- WSL2-specific handling (WSL2 is just Linux).
- Changing the security model, the plugin API version, or anything macOS users see.
- Windows testing in CI: nothing here can run Windows; Windows code is written carefully and documented as untested
  until someone runs it.

## Runtime (TypeScript/Python)

- `server/lib/platform.ts` (core, re-exported from `plugin-api/server.ts`): `idleSeconds()` per platform, the Python
  command (`WORK_HUB_PYTHON`, else `python3`, on Windows `python`), `ptyBridgeSpawnArgs()`, the default terminal shell
  and its arguments, the default termd socket path (a named pipe `\\.\pipe\work-hub-termd-<user>` on Windows).
- Idle time: macOS `ioreg` (as now); Linux `xprintidle` (X11), else GNOME Mutter's IdleMonitor over `gdbus`, else
  `loginctl` IdleHint/IdleSinceHint, else unknown (null: work while watched, as today); Windows one long-lived hidden
  PowerShell that prints `GetLastInputInfo` idle milliseconds every few seconds (no per-tick PowerShell start-up cost).
- `ptybridge.py`: POSIX branch unchanged; a Windows branch on ConPTY through `pywinpty` (`pip install pywinpty`),
  threads instead of `select`, the fd-3 resize channel when the CRT hands it over. `prereqs.ts` checks pywinpty on
  Windows.
- termd: named pipe on Windows (no unlink/chmod), default shell `pwsh.exe` else `powershell.exe` with `-NoLogo`
  (POSIX: `$SHELL -l`, `/bin/sh` fallback rather than `/bin/zsh`), absolute paths checked with `path.isAbsolute`.
- `bin/wh-term-run`: BSD `script` (macOS), util-linux `script -c` (Linux), else `tee` (Git Bash on Windows). On Windows
  the terminal types the line through Git Bash (`bash.exe`). `bin/wh.cmd` lets cmd/PowerShell users run `wh`.
- Path checks that assume `/` (`startsWith('/')`, `root + '/'`) use `path.isAbsolute`/`path.sep` helpers.
- auth: mkcert CAROOT on Windows is `%LOCALAPPDATA%\mkcert`.

## Background agents

| | macOS (unchanged) | Linux | Windows |
| --- | --- | --- | --- |
| Mechanism | launchd LaunchAgents | systemd user units | Scheduled Tasks (at logon, current user, hidden) |
| Where | `~/Library/LaunchAgents/<label>.plist` | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/<label>.service` (`WORK_HUB_SYSTEMD_USER_DIR`) | task folder `\work-hub\`, launcher `<state>\agents\<label>.cmd` |
| Ownership mark | `EnvironmentVariables.WORK_HUB_REPO` | `Environment=WORK_HUB_REPO=<checkout>` | task Description `WORK_HUB_REPO=<checkout>` |
| Restart | `launchctl kickstart -k` | `systemctl --user restart` | `Stop-ScheduledTask`/`Start-ScheduledTask` |
| Logs | `~/Library/Logs/work-hub` | `${XDG_STATE_HOME:-~/.local/state}/work-hub/logs` | `<state dir>\logs` (default `%USERPROFILE%\.local\state\work-hub\logs`) |

Labels keep the same prefix rule (`com.<user>.work-hub[-suffix]`) everywhere. Linux keeps the bash scripts with a
backend switch in `scripts/lib/` (tested with a fake `systemctl`, like the fake `launchctl`); Windows gets PowerShell
twins with the same flags in PowerShell style (`-Apply`, `-Hostname`, `-Adopt`…).

## Certificates and clipboard

- Trust the mkcert CA: `scripts/trust-ca-mac.sh` (as now), `scripts/trust-ca-linux.sh` (`mkcert -install`, which
  covers the system store and NSS; dry run by default), `scripts/windows/trust-ca.ps1` (`certutil -user -addstore Root`).
- Share the CA: `share-ca.sh` reveals with Finder on macOS, `xdg-open` on the folder on Linux; `share-ca.ps1` uses
  Explorer `/select`.
- The sign-in link: `pbcopy` (macOS), `wl-copy`/`xclip`/`xsel` (Linux), `Set-Clipboard` (Windows). Never printed.
- Tool hints say `brew install`, `apt/dnf install` or `winget install` by platform; binaries come from `command -v`
  before any Homebrew default path.

## Calls made by the builder (not the owner)

Defaults above (named pipe name, Scheduled Tasks over a Windows service, pywinpty over node-pty, keeping the
home-relative XDG-style dirs on Windows too) are the builder's calls, chosen to need no admin rights and no native
npm build.
