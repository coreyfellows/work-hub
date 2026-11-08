#!/usr/bin/env bash
# Set up a fresh clone (macOS, Linux): check what work-hub needs, install, build, and run it in the background on
# http://127.0.0.1:$WORK_HUB_PORT (4848), started again at every login. It's what to run (or what Claude runs) when
# someone says "set this repo up". Localhost mode: no hostname, no sign-in, nothing reachable from other devices (for
# that, scripts/setup-lan.sh afterwards).
#
#   1. checks: Node 26+, pnpm, git, python3, the claude CLI (signed in); gh is optional (GitHub features). Each missing
#      one is listed with the command that fixes it.
#   2. --apply: pnpm install --frozen-lockfile, pnpm build, then the background service: a launchd agent (macOS) or a
#      systemd user unit (Linux) labelled ${WORK_HUB_LAUNCHD_PREFIX:-com.<user>.work-hub}, running node server/index.ts.
#      If that agent already exists for this checkout (say LAN access is set up), it's kept as it is and restarted.
#   3. waits until the server answers, then prints the address.
#
# Usage: scripts/setup.sh [--apply] [--no-service] [--uninstall] [--adopt]
#   (none)        dry run: the checks and what --apply would do; exits 1 when something is missing
#   --apply       do it
#   --no-service  install and build only; you run `pnpm start` yourself (it stops when that terminal closes)
#   --uninstall   stop and remove the background service (state, config and the checkout stay)
#   --adopt       take over an agent with the same label that points at another checkout (e.g. after moving the repo)
# Env: WORK_HUB_PORT (4848), WORK_HUB_STATE_DIR, WORK_HUB_CONFIG_DIR, WORK_HUB_CACHE_DIR, WORK_HUB_LAUNCHD_PREFIX,
# WORK_HUB_LAUNCH_AGENTS_DIR, WORK_HUB_SYSTEMD_USER_DIR. Windows: see docs/windows.md.
set -euo pipefail

MODE=dry-run
SERVICE=true
ADOPT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) MODE=apply ;;
    --uninstall) MODE=uninstall ;;
    --no-service) SERVICE=false ;;
    --adopt) ADOPT=true ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "usage: $0 [--apply] [--no-service] [--uninstall] [--adopt]" >&2; exit 2 ;;
  esac
  shift
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/launchd.sh
source "$REPO/scripts/lib/launchd.sh"
PREFIX="${WORK_HUB_LAUNCHD_PREFIX:-$LAUNCHD_PREFIX_DEFAULT}"
LABEL="$PREFIX"
STATE="${WORK_HUB_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/work-hub}"
CONFIG="${WORK_HUB_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/work-hub}"
CACHE="${WORK_HUB_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/work-hub}"
PORT="${WORK_HUB_PORT:-4848}"
URL="http://127.0.0.1:$PORT"
LOG_DIR="$AGENT_LOG_DIR"
NODE_MIN=26

if [[ "$MODE" == uninstall ]]; then
  agent_require_backend
  if [[ ! -e "$(agent_file "$LABEL")" ]]; then echo "No background service $LABEL installed; nothing to do."; exit 0; fi
  launchd_check_owned apply "$LABEL" || exit 1
  agent_unload "$LABEL"
  rm -f "$(agent_file "$LABEL")"
  agent_forget
  echo "Stopped and removed $LABEL. Your workspaces and settings ($STATE, $CONFIG) are kept."
  [[ -e "$(agent_file "$PREFIX-tls")" ]] && echo "LAN access agents are still installed: scripts/setup-lan.sh --uninstall removes them."
  exit 0
fi

# --- 1. checks ------------------------------------------------------------------------------------------------------
missing=() # "what — how to fix it"
fix() { if [[ "$WORK_HUB_PLATFORM" == Darwin ]]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
ok() { printf '  ✓ %s\n' "$1"; }

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  missing+=("Node.js $NODE_MIN or newer — $(fix 'brew install node' "install Node $NODE_MIN+ (e.g. nvm install $NODE_MIN, or https://nodejs.org)")")
else
  NODE_VER="$("$NODE" -p 'process.versions.node')"
  if (( ${NODE_VER%%.*} < NODE_MIN )); then
    missing+=("Node.js $NODE_MIN or newer (found $NODE_VER) — $(fix 'brew install node (or brew upgrade node)' "install Node $NODE_MIN+ (e.g. nvm install $NODE_MIN, or https://nodejs.org)")")
  else ok "Node.js $NODE_VER"; fi
fi
PNPM="$(command -v pnpm || true)"
if [[ -n "$PNPM" ]]; then ok "pnpm"
else missing+=("pnpm — corepack enable pnpm (comes with Node; or: npm install -g pnpm)"); fi
if command -v git >/dev/null 2>&1; then ok "git"; else missing+=("git — $(fix 'xcode-select --install' 'apt install git / dnf install git')"); fi
if command -v python3 >/dev/null 2>&1; then ok "python3"; else missing+=("python3 (used to type into Claude sessions) — $(fix 'xcode-select --install' 'apt install python3 / dnf install python3')"); fi
if ! command -v claude >/dev/null 2>&1; then
  missing+=("the claude CLI — npm install -g @anthropic-ai/claude-code (https://docs.claude.com/en/docs/claude-code)")
elif claude auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
  ok "claude CLI, signed in"
else
  missing+=("claude isn't signed in — run \`claude\` once in a terminal and sign in (/login)")
fi
NOTES=()
if command -v gh >/dev/null 2>&1; then ok "gh (GitHub CLI)"
else NOTES+=("optional: the GitHub features (PR lists, PR sessions) need gh signed in: $(fix 'brew install gh' 'install gh (https://cli.github.com)') && gh auth login"); fi

EXISTING=false  # this checkout's agent is installed: keep it as it is and restart it
ADOPTING=false  # another checkout's agent, taken over with --adopt: replaced by ours
if [[ "$SERVICE" == true ]]; then
  if [[ "$SERVICE_BACKEND" == unsupported ]]; then
    missing+=("a background service manager — $WORK_HUB_PLATFORM has none here: use --no-service (Windows: docs/windows.md)")
  elif [[ -e "$(agent_file "$LABEL")" ]]; then
    reason="$(launchd_foreign_reason "$LABEL")"
    if [[ -n "$reason" && "$ADOPT" != true ]]; then
      missing+=("the background service $LABEL belongs to another checkout ($reason) — run setup from that checkout, pass --adopt to move it here, or set WORK_HUB_LAUNCHD_PREFIX to another label")
    elif [[ -n "$reason" ]]; then
      ADOPTING=true
      ok "background service $LABEL belongs to another checkout; --adopt replaces it with this one's"
    else
      EXISTING=true
      ok "background service $LABEL already installed for this checkout (kept, restarted)"
    fi
  fi
  # (An agent we restart or replace may hold the port itself.)
  if [[ "$EXISTING" == false && "$ADOPTING" == false ]] && port_listening "$PORT"; then
    missing+=("port $PORT is already in use by something else — stop it, or set WORK_HUB_PORT to a free port (e.g. WORK_HUB_PORT=4850)")
  fi
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing:"
  printf '  ✗ %s\n' "${missing[@]}"
  if [[ "$WORK_HUB_PLATFORM" == Darwin ]] && ! command -v brew >/dev/null 2>&1 && printf '%s\n' "${missing[@]}" | grep -q 'brew '; then
    echo "  ! the brew fixes need Homebrew, which isn't installed: paste the install command from https://brew.sh into"
    echo "    Terminal (it asks for your Mac password), then follow what it prints to add brew to your PATH."
  fi
fi
[[ ${#NOTES[@]} -gt 0 ]] && printf '  · %s\n' "${NOTES[@]}"

# --- dry run --------------------------------------------------------------------------------------------------------
if [[ "$MODE" == dry-run ]]; then
  echo
  echo "Dry run. With --apply this would:"
  echo "  pnpm install --frozen-lockfile, pnpm build"
  if [[ "$SERVICE" == false ]]; then echo "  stop there: you run \`pnpm start\` and open $URL"
  elif [[ "$EXISTING" == true ]]; then echo "  restart the background service $LABEL and wait for it"
  else
    echo "  install the background service $LABEL ($AGENT_NOUN in $AGENTS_DIR): node server/index.ts on $URL,"
    echo "  started at login, logs in $LOG_DIR/$LABEL.log; state in $STATE, config in $CONFIG"
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then echo "Fix what's missing first, then run: scripts/setup.sh --apply"; exit 1; fi
  echo "Everything needed is there. Run: scripts/setup.sh --apply"
  exit 0
fi

# --- 2. apply -------------------------------------------------------------------------------------------------------
if [[ ${#missing[@]} -gt 0 ]]; then echo "Not set up: fix what's missing above, then run this again." >&2; exit 1; fi

echo "Installing dependencies…"
(cd "$REPO" && "$PNPM" install --frozen-lockfile >/dev/null) || { echo "pnpm install failed; run it in $REPO to see why" >&2; exit 1; }
echo "Building…"
(cd "$REPO" && "$PNPM" build >/dev/null) || { echo "pnpm build failed; run it in $REPO to see why" >&2; exit 1; }

if [[ "$SERVICE" == false ]]; then
  echo "Done. Start it with \`pnpm start\` in $REPO (it runs while that terminal is open), then open $URL"
  exit 0
fi

mkdir -p "$LOG_DIR" "$AGENTS_DIR" "$STATE"
chmod 700 "$STATE"
if [[ "$EXISTING" == true ]]; then
  agent_restart "$LABEL" >/dev/null 2>&1 || agent_load "$LABEL" >/dev/null 2>&1 || { echo "couldn't restart $LABEL" >&2; exit 1; }
else
  # The service manager starts it with a minimal PATH: give it node's, claude's and gh's folders and the usual ones.
  path_dirs="$(dirname "$NODE")"
  for t in claude gh git python3; do
    d="$(dirname "$(command -v "$t" 2>/dev/null || echo /usr/bin/x)")"
    [[ ":$path_dirs:" == *":$d:"* ]] || path_dirs="$path_dirs:$d"
  done
  path_dirs="$path_dirs:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  ENVS=(NODE_ENV production WORK_HUB_PORT "$PORT" PATH "$path_dirs" WORK_HUB_STATE_DIR "$STATE" WORK_HUB_CONFIG_DIR "$CONFIG" WORK_HUB_CACHE_DIR "$CACHE")
  ARGS=("$NODE" "$REPO/server/index.ts")
  agent_unload "$LABEL"
  if [[ "$SERVICE_BACKEND" == systemd ]]; then
    systemd_unit_body "$LABEL" "$REPO" "$LOG_DIR/$LABEL.log" "${ENVS[@]}" -- "${ARGS[@]}" > "$(agent_file "$LABEL")"
    agent_load "$LABEL" >/dev/null 2>&1 || { echo "couldn't start $LABEL (systemctl --user status $LABEL.service)" >&2; exit 1; }
  else
    xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
    env_xml="" args_xml=""
    set -- "${ENVS[@]}"
    while [[ $# -gt 1 ]]; do env_xml="$env_xml<key>$1</key><string>$(xml "$2")</string>"; shift 2; done
    for a in "${ARGS[@]}"; do args_xml="$args_xml<string>$(xml "$a")</string>"; done
    cat > "$(agent_file "$LABEL")" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$(xml "$REPO")</string>
  <key>ProgramArguments</key><array>$args_xml</array>
  <key>EnvironmentVariables</key><dict>$(launchd_repo_env_xml)$env_xml</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG_DIR/$LABEL.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_DIR/$LABEL.log")</string>
</dict>
</plist>
EOF
    plutil -lint "$(agent_file "$LABEL")" >/dev/null || { echo "bad plist: $(agent_file "$LABEL")" >&2; exit 1; }
    # bootout returns before launchd has fully let go; an immediate bootstrap can fail with "5: Input/output error".
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      agent_load "$LABEL" 2>/dev/null && break
      [[ $attempt == 10 ]] && { echo "couldn't load $LABEL (launchctl print gui/$(id -u)/$LABEL)" >&2; exit 1; }
      sleep 0.5
    done
  fi
fi

# --- 3. wait --------------------------------------------------------------------------------------------------------
for _ in $(seq 1 120); do
  if port_listening "$PORT"; then
    echo
    echo "work-hub is running: open $URL in a browser on this machine."
    echo "  The first visit asks where your repos are cloned and where worktrees go (defaults ~/repos and ~/worktrees)."
    echo "  It runs in the background and starts again at login ($LABEL; logs: $LOG_DIR/$LABEL.log)."
    echo "  Update later: scripts/update.sh. Remove the service: scripts/setup.sh --uninstall."
    agent_linger_note
    exit 0
  fi
  sleep 0.5
done
echo "The service started but nothing answers on port $PORT after 60s; see $LOG_DIR/$LABEL.log" >&2
tail -20 "$LOG_DIR/$LABEL.log" >&2 2>/dev/null || true
exit 1
