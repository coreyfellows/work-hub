#!/usr/bin/env bash
# Install (or remove) a background agent that keeps SilverBullet serving your notes folder for the notes plugin: a
# launchd agent on macOS, a systemd user unit on Linux (scripts/lib/service.sh; `loginctl enable-linger $USER` keeps it
# running after you log out).
#
#   label    ${WORK_HUB_LAUNCHD_PREFIX:-com.<user>.work-hub}-notes
#   listens  127.0.0.1:<port> only (default 18744), under the URL prefix /notes
#   serves   <notes dir> (default ~/notes), single-space mode, no SilverBullet login, shell commands off
#
# There is no SilverBullet login because it only listens on loopback: anything that can reach it is already on this
# machine. With LAN access on, the front proxy (scripts/setup-lan.sh) sends /notes to it only after work-hub's sign-in.
# Never change the bind address to anything but 127.0.0.1.
#
# Dry run by default (prints what it would do); --apply installs or reinstalls (idempotent), --uninstall removes it.
#
# Usage: install-agent.sh [--apply | --uninstall] [--port N] [--notes-dir DIR] [--bin PATH] [--prefix LABEL_PREFIX] [--adopt]
# Each value: the flag, else its env var (WORK_HUB_NOTES_LOCAL_PORT, WORK_HUB_NOTES_NOTES_DIR, WORK_HUB_NOTES_SILVERBULLET,
# WORK_HUB_LAUNCHD_PREFIX), else plugins.json settings.notes.{localPort,notesDir,silverbullet}, else the default.
# The plist (unit) is stamped with this checkout (EnvironmentVariables.WORK_HUB_REPO; Environment=WORK_HUB_REPO=…); an
# existing one that points at another checkout is never stopped, replaced or removed unless --adopt is given
# (scripts/lib/launchd.sh). Env: WORK_HUB_LAUNCH_AGENTS_DIR (where the plist goes; default ~/Library/LaunchAgents),
# WORK_HUB_SYSTEMD_USER_DIR (Linux: where the unit goes; default ${XDG_CONFIG_HOME:-~/.config}/systemd/user).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=../../../scripts/lib/launchd.sh
source "$REPO/scripts/lib/launchd.sh"

# plugins.json settings for this plugin (the same ones scripts/setup-lan.sh reads), so both write the same agent.
PLUGINS_FILE="${WORK_HUB_PLUGINS_FILE:-${WORK_HUB_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/work-hub}/plugins.json}"
setting() { # plugin id, key -> the value, or empty
  [[ -r "$PLUGINS_FILE" ]] && command -v node >/dev/null 2>&1 || return 0
  node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).settings?.[process.argv[2]]?.[process.argv[3]];
    if (v !== undefined && v !== null) console.log(String(v)); } catch {}' "$PLUGINS_FILE" "$1" "$2"
}

MODE="dry-run"
PORT="${WORK_HUB_NOTES_LOCAL_PORT:-$(setting notes localPort)}"; PORT="${PORT:-18744}"
NOTES_DIR="${WORK_HUB_NOTES_NOTES_DIR:-$(setting notes notesDir)}"; NOTES_DIR="${NOTES_DIR:-$HOME/notes}"
BIN="${WORK_HUB_NOTES_SILVERBULLET:-$(setting notes silverbullet)}"
BIN="${BIN:-$(command -v silverbullet || echo "$HOME/.local/bin/silverbullet")}"
PREFIX="${WORK_HUB_LAUNCHD_PREFIX:-$LAUNCHD_PREFIX_DEFAULT}"
ADOPT=false
URL_PREFIX="/notes"

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; }
need() { [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) MODE="apply" ;;
    --uninstall) MODE="uninstall" ;;
    --port) need "$1" "${2:-}"; PORT="$2"; shift ;;
    --notes-dir) need "$1" "${2:-}"; NOTES_DIR="$2"; shift ;;
    --bin) need "$1" "${2:-}"; BIN="$2"; shift ;;
    --prefix) need "$1" "${2:-}"; PREFIX="$2"; shift ;;
    --adopt) ADOPT=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

[[ "$SERVICE_BACKEND" != unsupported ]] || { echo "This script installs a launchd agent (macOS) or a systemd user unit (Linux). Elsewhere, run under your own supervisor:" >&2
  echo "  SB_URL_PREFIX=$URL_PREFIX SB_SHELL_BACKEND=off silverbullet --single -L 127.0.0.1 -p $PORT $NOTES_DIR" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "--port must be a number (got $PORT)" >&2; exit 2; }
[[ "$NOTES_DIR" == /* ]] || { echo "--notes-dir must be an absolute path (got $NOTES_DIR)" >&2; exit 2; }

LABEL="$PREFIX-notes"
AGENTS="$AGENTS_DIR"
PLIST="$(agent_file "$LABEL")"
LOG_DIR="$AGENT_LOG_DIR"
LOG="$LOG_DIR/$LABEL.log"
DOMAIN="$(agent_domain)"

loaded() { agent_loaded "$LABEL"; }
listening() { port_listening "$PORT"; }
stop_agent() { # bootout returns before the job is gone; bootstrap right after it can fail
  loaded || return 0
  agent_unload "$LABEL"
  for _ in $(seq 1 20); do loaded || return 0; sleep 0.25; done
}

if [[ "$MODE" == uninstall ]]; then
  launchd_check_owned apply "$LABEL" || exit 1
  stop_agent
  [[ "$SERVICE_BACKEND" == systemd ]] && agent_unload "$LABEL" # disable it too, even when it wasn't running
  rm -f "$PLIST"
  agent_forget
  echo "Removed $LABEL (your notes in $NOTES_DIR are untouched)."
  exit 0
fi

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

if [[ "$SERVICE_BACKEND" == systemd ]]; then
  PLIST_BODY="$(systemd_unit_body "$LABEL" "$NOTES_DIR" "$LOG" SB_URL_PREFIX "$URL_PREFIX" SB_SHELL_BACKEND off \
    -- "$BIN" --single -L 127.0.0.1 -p "$PORT" "$NOTES_DIR")"
else
PLIST_BODY="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$(xml "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$BIN")</string>
    <string>--single</string>
    <string>-L</string><string>127.0.0.1</string>
    <string>-p</string><string>$PORT</string>
    <string>$(xml "$NOTES_DIR")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    $(launchd_repo_env_xml)
    <key>SB_URL_PREFIX</key><string>$URL_PREFIX</string>
    <key>SB_SHELL_BACKEND</key><string>off</string>
  </dict>
  <key>WorkingDirectory</key><string>$(xml "$NOTES_DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>"
fi

problems=0
if [[ ! -x "$BIN" ]]; then
  echo "SilverBullet not found at $BIN: install it (see SETUP.md) or pass --bin." >&2
  problems=1
fi
if listening && ! loaded; then
  echo "Port $PORT is already in use by something else: pick another with --port." >&2
  problems=1
fi

if [[ "$MODE" == dry-run ]]; then
  echo "Dry run. With --apply this would:"
  [[ -d "$NOTES_DIR" ]] || echo "  create $NOTES_DIR"
  loaded && echo "  stop the running $LABEL"
  launchd_check_owned dry-run "$LABEL"
  echo "  write $PLIST:"
  sed 's/^/    /' <<<"$PLIST_BODY"
  echo "  start it ($DOMAIN) and wait for 127.0.0.1:$PORT; log: $LOG"
  echo "Then point the notes plugin at http://127.0.0.1:$PORT$URL_PREFIX (see SETUP.md)."
  [[ $problems -eq 0 ]] || { echo "Fix the problems above before --apply." >&2; exit 1; }
  exit 0
fi

[[ $problems -eq 0 ]] || exit 1
launchd_check_owned apply "$LABEL" || exit 1
mkdir -p "$NOTES_DIR" "$AGENTS" "$LOG_DIR"
stop_agent
printf '%s\n' "$PLIST_BODY" > "$PLIST"
agent_load "$LABEL"
for _ in $(seq 1 40); do
  if listening; then
    echo "$LABEL is serving $NOTES_DIR at http://127.0.0.1:$PORT$URL_PREFIX"
    agent_linger_note
    exit 0
  fi
  sleep 0.5
done
echo "$LABEL didn't start listening on 127.0.0.1:$PORT; see $LOG" >&2
exit 1
