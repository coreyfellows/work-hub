#!/usr/bin/env bash
# The auth plugin's sign-in token: create it if it isn't there (0600, in the 0700 state dir) and copy the one-tap
# sign-in link https://<hostname>[:<port>]/login#t=<token> to the clipboard (pbcopy on macOS; on Linux wl-copy under
# Wayland, else xclip, else xsel). The token is never printed: it sits in the URL fragment, which the browser never
# sends to the server, and the login page drops it after use. With Universal Clipboard the link is on your phone too. After the first sign-in, add a passkey or pair other devices from
# Settings.
#
# Usage: setup-auth.sh --hostname <name> [--port <public port>] [--apply] [--rotate] [--adopt]   (or WORK_HUB_HOSTNAME=<name>)
#   --apply   create the token if missing and copy the link (without it: a dry run saying what would happen)
#   --rotate  with --apply: replace the token first, which signs every device out, and restart the server agent
#             scripts/setup-lan.sh installed; refused (before the token changes) if that agent's plist (Linux: systemd
#             user unit) points at another checkout (scripts/lib/launchd.sh), unless --adopt
# Env: WORK_HUB_STATE_DIR, WORK_HUB_AUTH_TOKEN_FILE (or plugins.json settings.auth.tokenFile, read with jq; or
# WORK_HUB_TOKEN_FILE), WORK_HUB_CONFIG_DIR / WORK_HUB_PLUGINS_FILE, WORK_HUB_PUBLIC_PORT (443),
# WORK_HUB_LAUNCHD_PREFIX, WORK_HUB_LAUNCH_AGENTS_DIR, WORK_HUB_SYSTEMD_USER_DIR.
set -euo pipefail

APPLY=false
ROTATE=false
ADOPT=false
HOST="${WORK_HUB_HOSTNAME:-}"
PORT="${WORK_HUB_PUBLIC_PORT:-443}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --rotate) ROTATE=true ;;
    --adopt) ADOPT=true ;;
    --hostname) HOST="${2:-}"; shift ;;
    --hostname=*) HOST="${1#--hostname=}" ;;
    --port) PORT="${2:-}"; shift ;;
    --port=*) PORT="${1#--port=}" ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "usage: $0 --hostname <name> [--port <n>] [--apply] [--rotate] [--adopt]" >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$HOST" ]] || { echo "A hostname is required: --hostname <name> or WORK_HUB_HOSTNAME (the name the app is served at)" >&2; exit 2; }
[[ "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "Not a hostname: $HOST" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "Not a port: $PORT" >&2; exit 2; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/launchd.sh
source "$REPO/scripts/lib/launchd.sh"
STATE="${WORK_HUB_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/work-hub}"
CONFIG="${WORK_HUB_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/work-hub}"
PLUGINS_FILE="${WORK_HUB_PLUGINS_FILE:-$CONFIG/plugins.json}"
# Same order the server reads it in: WORK_HUB_AUTH_TOKEN_FILE, plugins.json settings.auth.tokenFile, WORK_HUB_TOKEN_FILE, <state>/token.
SETTING_TOKEN_FILE=""
if [[ -z "${WORK_HUB_AUTH_TOKEN_FILE:-}" && -s "$PLUGINS_FILE" ]]; then
  if command -v jq >/dev/null; then
    SETTING_TOKEN_FILE="$(jq -r '.settings.auth.tokenFile // empty | strings' "$PLUGINS_FILE")" \
      || { echo "Can't parse $PLUGINS_FILE" >&2; exit 1; }
  elif grep -q '"tokenFile"' "$PLUGINS_FILE"; then
    echo "$PLUGINS_FILE may set settings.auth.tokenFile, and reading it needs jq ($(install_hint jq))" >&2; exit 1
  fi
fi
TOKEN_FILE="${WORK_HUB_AUTH_TOKEN_FILE:-${SETTING_TOKEN_FILE:-${WORK_HUB_TOKEN_FILE:-$STATE/token}}}"
TOKEN_DIR="$(dirname "$TOKEN_FILE")"
PREFIX="${WORK_HUB_LAUNCHD_PREFIX:-$LAUNCHD_PREFIX_DEFAULT}"
if [[ "$PORT" == 443 ]]; then URL="https://$HOST/login"; else URL="https://$HOST:$PORT/login"; fi

# The clipboard command, as words in CLIP (empty when there is none). Linux tools fork to keep serving the selection,
# so copy_link sends their output to /dev/null (else a caller reading this script's output would wait on them).
CLIP=()
if [[ "$WORK_HUB_PLATFORM" == Darwin ]]; then
  command -v pbcopy >/dev/null && CLIP=(pbcopy)
elif [[ -n "${WAYLAND_DISPLAY:-}" ]] && command -v wl-copy >/dev/null; then CLIP=(wl-copy)
elif command -v xclip >/dev/null; then CLIP=(xclip -selection clipboard)
elif command -v xsel >/dev/null; then CLIP=(xsel --clipboard --input)
fi
copy_link() { # stdin -> the clipboard
  if [[ "${CLIP[0]}" == pbcopy ]]; then pbcopy; else "${CLIP[@]}" >/dev/null 2>&1; fi
}

new_token() { # 24 random bytes, base64url, like the server makes
  (umask 077; openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n' > "$TOKEN_FILE.tmp")
  mv "$TOKEN_FILE.tmp" "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
}

if [[ "$APPLY" == false ]]; then
  echo "Dry run (nothing changed):"
  if [[ "$ROTATE" == true ]]; then
    echo "  would replace the token in $TOKEN_FILE, signing every device out, and restart $PREFIX if it's loaded"
    launchd_check_owned dry-run "$PREFIX"
  elif [[ -s "$TOKEN_FILE" ]]; then
    echo "  the token in $TOKEN_FILE exists; it would be left as is"
  else
    echo "  would create a token in $TOKEN_FILE (0600; its folder 0700 if this script creates it or it is the state dir)"
  fi
  echo "  would copy the sign-in link for $URL to the clipboard (the token is never printed)"
  echo "Re-run with --apply."
  exit 0
fi

# Rotating restarts the server agent: check it is this checkout's before anything changes.
if [[ "$ROTATE" == true ]]; then launchd_check_owned apply "$PREFIX" || exit 1; fi
if [[ ${#CLIP[@]} -eq 0 ]]; then
  if [[ "$WORK_HUB_PLATFORM" == Darwin ]]; then
    echo "pbcopy not found: this script copies the link to the macOS clipboard and never prints it" >&2
  else
    echo "No clipboard tool found: install wl-clipboard (Wayland) or xclip / xsel (X11), e.g. $(install_hint wl-clipboard); this script copies the link to the clipboard and never prints it" >&2
  fi
  exit 1
fi
# Tighten only a folder this script makes, or the state dir itself: never some existing parent the token file points into.
if [[ ! -d "$TOKEN_DIR" ]]; then
  mkdir -p "$TOKEN_DIR"
  chmod 700 "$TOKEN_DIR"
elif [[ "$TOKEN_DIR" -ef "$STATE" ]]; then
  chmod 700 "$TOKEN_DIR"
fi

if [[ "$ROTATE" == true ]]; then
  new_token
  echo "Replaced the token; every device is signed out."
  if agent_loaded "$PREFIX" && { [[ "$ADOPT" == true ]] || launchd_points_here "$PREFIX"; }; then
    agent_restart "$PREFIX"
    echo "Restarted $PREFIX so it uses the new token."
  else
    echo "Restart the server so it uses the new token ($PREFIX isn't loaded, or has no $AGENT_FILE_NOUN of this checkout)."
  fi
elif [[ ! -s "$TOKEN_FILE" ]]; then
  new_token
  echo "Created a token in $TOKEN_FILE."
fi
chmod 600 "$TOKEN_FILE"

printf '%s#t=%s' "$URL" "$(tr -d '\n' < "$TOKEN_FILE")" | copy_link
echo "Copied the sign-in link for $URL to the clipboard; paste it into the browser (it signs in once)."
