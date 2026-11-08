#!/usr/bin/env bash
# Install (or remove) a background agent that keeps VS Code's `serve-web` running for the code plugin: a launchd agent
# on macOS, a systemd user unit on Linux (scripts/lib/service.sh; `loginctl enable-linger $USER` keeps it running after
# you log out).
#
#   label    ${WORK_HUB_LAUNCHD_PREFIX:-com.<user>.work-hub}-code
#   listens  127.0.0.1:<port> only (default 18743), under the base path /code
#   token    a connection token in <token file> (default ~/.local/state/vscode-serve-web.token, the plugin's default),
#            created here (0600) if missing and never printed. work-hub reads it and hands it only to its own UI.
#
# With LAN access on, the front proxy (scripts/setup-lan.sh) sends /code to it only after work-hub's sign-in.
# Never change the bind address to anything but 127.0.0.1.
#
# Dry run by default (prints what it would do); --apply installs or reinstalls (idempotent), --uninstall removes it
# (the token file is kept; delete it yourself if you want a new one).
#
# Usage: install-agent.sh [--apply | --uninstall] [--port N] [--token-file FILE] [--cli PATH] [--prefix LABEL_PREFIX] [--adopt]
# Each value: the flag, else its env var (WORK_HUB_CODE_LOCAL_PORT, WORK_HUB_CODE_VSCODE_TOKEN_FILE, WORK_HUB_CODE_CLI,
# WORK_HUB_LAUNCHD_PREFIX), else plugins.json settings.code.{localPort,vscodeTokenFile,cli}, else the default.
# The plist (unit) is stamped with this checkout (EnvironmentVariables.WORK_HUB_REPO; Environment=WORK_HUB_REPO=…); an
# existing one that points at another checkout is never stopped, replaced or removed unless --adopt is given
# (scripts/lib/launchd.sh). Env: WORK_HUB_LAUNCH_AGENTS_DIR (where the plist goes; default ~/Library/LaunchAgents),
# WORK_HUB_SYSTEMD_USER_DIR (Linux: where the unit goes; default ${XDG_CONFIG_HOME:-~/.config}/systemd/user).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=../../../scripts/lib/launchd.sh
source "$REPO/scripts/lib/launchd.sh"

APP_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel"
default_cli() {
  if [[ -x "$APP_CLI" ]]; then echo "$APP_CLI"; return; fi
  command -v code-tunnel || command -v code || echo "$APP_CLI"
}

# plugins.json settings for this plugin (the same ones scripts/setup-lan.sh reads), so both write the same agent.
PLUGINS_FILE="${WORK_HUB_PLUGINS_FILE:-${WORK_HUB_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/work-hub}/plugins.json}"
setting() { # plugin id, key -> the value, or empty
  [[ -r "$PLUGINS_FILE" ]] && command -v node >/dev/null 2>&1 || return 0
  node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).settings?.[process.argv[2]]?.[process.argv[3]];
    if (v !== undefined && v !== null) console.log(String(v)); } catch {}' "$PLUGINS_FILE" "$1" "$2"
}

MODE="dry-run"
PORT="${WORK_HUB_CODE_LOCAL_PORT:-$(setting code localPort)}"; PORT="${PORT:-18743}"
TOKEN_FILE="${WORK_HUB_CODE_VSCODE_TOKEN_FILE:-$(setting code vscodeTokenFile)}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.local/state/vscode-serve-web.token}"
CLI="${WORK_HUB_CODE_CLI:-$(setting code cli)}"; CLI="${CLI:-$(default_cli)}"
PREFIX="${WORK_HUB_LAUNCHD_PREFIX:-$LAUNCHD_PREFIX_DEFAULT}"
ADOPT=false
BASE_PATH="/code"

usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; }
need() { [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) MODE="apply" ;;
    --uninstall) MODE="uninstall" ;;
    --port) need "$1" "${2:-}"; PORT="$2"; shift ;;
    --token-file) need "$1" "${2:-}"; TOKEN_FILE="$2"; shift ;;
    --cli) need "$1" "${2:-}"; CLI="$2"; shift ;;
    --prefix) need "$1" "${2:-}"; PREFIX="$2"; shift ;;
    --adopt) ADOPT=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

[[ "$SERVICE_BACKEND" != unsupported ]] || { echo "This script installs a launchd agent (macOS) or a systemd user unit (Linux). Elsewhere, run under your own supervisor:" >&2
  echo "  code serve-web --accept-server-license-terms --host 127.0.0.1 --port $PORT --server-base-path $BASE_PATH --connection-token-file $TOKEN_FILE" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "--port must be a number (got $PORT)" >&2; exit 2; }
[[ "$TOKEN_FILE" == /* ]] || { echo "--token-file must be an absolute path (got $TOKEN_FILE)" >&2; exit 2; }

LABEL="$PREFIX-code"
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
  echo "Removed $LABEL (the token file $TOKEN_FILE is kept)."
  exit 0
fi

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

if [[ "$SERVICE_BACKEND" == systemd ]]; then
  PLIST_BODY="$(systemd_unit_body "$LABEL" "$HOME" "$LOG" -- "$CLI" serve-web --accept-server-license-terms --host 127.0.0.1 \
    --port "$PORT" --server-base-path "$BASE_PATH" --connection-token-file "$TOKEN_FILE")"
else
PLIST_BODY="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$(xml "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$CLI")</string>
    <string>serve-web</string>
    <string>--accept-server-license-terms</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$PORT</string>
    <string>--server-base-path</string><string>$BASE_PATH</string>
    <string>--connection-token-file</string><string>$(xml "$TOKEN_FILE")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    $(launchd_repo_env_xml)
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>"
fi

problems=0
if [[ ! -x "$CLI" ]]; then
  echo "VS Code CLI not found at $CLI: install VS Code or the standalone CLI (see SETUP.md), or pass --cli." >&2
  problems=1
fi
if listening && ! loaded; then
  echo "Port $PORT is already in use by something else: pick another with --port." >&2
  problems=1
fi

if [[ "$MODE" == dry-run ]]; then
  echo "Dry run. With --apply this would:"
  if [[ -s "$TOKEN_FILE" ]]; then echo "  keep the existing token in $TOKEN_FILE"; else echo "  create a connection token in $TOKEN_FILE (0600)"; fi
  loaded && echo "  stop the running $LABEL"
  launchd_check_owned dry-run "$LABEL"
  echo "  write $PLIST:"
  sed 's/^/    /' <<<"$PLIST_BODY"
  echo "  start it ($DOMAIN) and wait for 127.0.0.1:$PORT; log: $LOG"
  echo "Then point the code plugin at http://127.0.0.1:$PORT$BASE_PATH (see SETUP.md)."
  [[ $problems -eq 0 ]] || { echo "Fix the problems above before --apply." >&2; exit 1; }
  exit 0
fi

[[ $problems -eq 0 ]] || exit 1
launchd_check_owned apply "$LABEL" || exit 1
mkdir -p "$(dirname "$TOKEN_FILE")" "$AGENTS" "$LOG_DIR"
if [[ ! -s "$TOKEN_FILE" ]]; then
  (umask 077; openssl rand -hex 24 > "$TOKEN_FILE")
  echo "Created a connection token in $TOKEN_FILE."
fi
chmod 600 "$TOKEN_FILE"
stop_agent
printf '%s\n' "$PLIST_BODY" > "$PLIST"
agent_load "$LABEL"
for _ in $(seq 1 60); do
  if listening; then
    echo "$LABEL is serving VS Code at http://127.0.0.1:$PORT$BASE_PATH"
    agent_linger_note
    exit 0
  fi
  sleep 0.5
done
echo "$LABEL didn't start listening on 127.0.0.1:$PORT (the first start downloads the VS Code server); see $LOG" >&2
exit 1
