#!/usr/bin/env bash
# Update this work-hub checkout and restart what runs it.
#
#   1. git pull --ff-only (skipped, with a note, when the branch has no upstream or with --no-pull),
#      pnpm install --frozen-lockfile, pnpm build (which also regenerates the plugins module)
#   2. restart the launchd agents you installed whose label starts with the prefix
#      (${WORK_HUB_LAUNCHD_PREFIX:-com.<user>.work-hub}; e.g. the server, its TLS front, notes, code), found with
#      `launchctl list`, never guessed, and only those whose plist points at this checkout (scripts/lib/launchd.sh:
#      another checkout's agents under the same prefix are left running); with none it tells you to restart your
#      `pnpm start`. On Linux the same for systemd user units (`systemctl --user list-units`, then
#      `systemctl --user restart`; the unit's Environment=WORK_HUB_REPO must point at this checkout)
#   3. the terminal daemon (<prefix>-term) is never restarted here, because that ends every shell: if its code changed
#      in this pull, it says so and you restart it when it suits you
#
# Migrations (the core's and each plugin's) run by themselves when the server starts.
#
# Usage: scripts/update.sh [--no-pull] [--no-restart] [--prefix LABEL_PREFIX]
#   --no-pull      don't pull: install, build and restart what's checked out (e.g. after merging locally)
#   --no-restart   pull, install and build only; print what would be restarted
#   --prefix P     launchd label prefix (default: $WORK_HUB_LAUNCHD_PREFIX, else com.<user>.work-hub, <user> = $USER with non [A-Za-z0-9-] → -)
# Env: WORK_HUB_LAUNCHD_PREFIX, WORK_HUB_LAUNCH_AGENTS_DIR (where the plists are; default ~/Library/LaunchAgents),
# WORK_HUB_SYSTEMD_USER_DIR (Linux: where the units are; default ${XDG_CONFIG_HOME:-~/.config}/systemd/user).
set -euo pipefail

RESTART=1
PULL=1
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/launchd.sh
source "$REPO/scripts/lib/launchd.sh"
PREFIX="${WORK_HUB_LAUNCHD_PREFIX:-$LAUNCHD_PREFIX_DEFAULT}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-restart) RESTART=0 ;;
    --no-pull) PULL=0 ;;
    --prefix) [[ -n "${2:-}" ]] || { echo "missing value for --prefix" >&2; exit 2; }; PREFIX="$2"; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

cd "$REPO"

# The daemon's code, wherever this checkout keeps it (it moved into the terminals plugin).
TERMD_FILES=(plugins/terminals/termd.ts server/termd.ts)

BEFORE="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM=""
if [[ $PULL -eq 0 ]]; then
  echo "--no-pull: building what's checked out ($BRANCH at ${BEFORE:0:7})."
elif ! UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
  UPSTREAM=""
  echo "$BRANCH has no upstream: not pulling; building what's checked out (${BEFORE:0:7})."
else
  echo "Pulling ($BRANCH from $UPSTREAM)…"
  git pull --ff-only
fi
AFTER="$(git rev-parse HEAD)"
if [[ -z "$UPSTREAM" ]]; then
  : # not pulled
elif [[ "$BEFORE" == "$AFTER" ]]; then
  echo "Already up to date at ${AFTER:0:7}; installing and building anyway (plugins.json may have changed)."
else
  echo "Updated ${BEFORE:0:7} → ${AFTER:0:7}."
fi

echo "Installing dependencies…"
pnpm install --frozen-lockfile
echo "Building…"
pnpm build

TERMD_CHANGED=0
if [[ "$BEFORE" != "$AFTER" ]] && [[ -n "$(git diff --name-only "$BEFORE" "$AFTER" -- "${TERMD_FILES[@]}")" ]]; then
  TERMD_CHANGED=1
fi

# Labels of installed agents (loaded in this login session) that start with the prefix and whose plist points at this
# checkout, except the terminal daemon.
AGENTS=()
TERM_INSTALLED=0
if agent_manager_available; then
  while IFS= read -r label; do
    [[ -n "$label" ]] || continue
    if ! launchd_points_here "$label"; then
      reason="$(launchd_foreign_reason "$label")"
      echo "Not restarting $label: ${reason:-no $AGENT_FILE_NOUN at $(agent_file "$label")}."
      continue
    fi
    if [[ "$label" == "$PREFIX-term" ]]; then TERM_INSTALLED=1; continue; fi
    AGENTS+=("$label")
  done < <(agent_list "$PREFIX")
fi

if [[ ${#AGENTS[@]} -eq 0 ]]; then
  echo "No ${AGENT_NOUN}s of this checkout starting with $PREFIX are installed: restart your \`pnpm start\` (or \`pnpm dev\`) to run the new build."
elif [[ $RESTART -eq 0 ]]; then
  echo "--no-restart: not restarting ${AGENTS[*]}"
  echo "  (each: $(agent_restart_cmd '<label>'))"
else
  for label in "${AGENTS[@]}"; do
    echo "Restarting ${label}…"
    agent_restart "$label"
  done
  agent_linger_note
fi

if [[ $TERMD_CHANGED -eq 1 ]]; then
  if [[ $TERM_INSTALLED -eq 1 ]]; then
    echo "The terminal daemon changed: restart $PREFIX-term when it suits you (this ends every shell):"
    echo "  $(agent_restart_cmd "$PREFIX-term")"
  else
    echo "The terminal daemon changed: restart it when it suits you (this ends every shell). It isn't a $AGENT_NOUN"
    echo "here: stop its process by its pid (the server logs it when it starts the daemon), then reload a page or restart the server."
  fi
fi
echo "Done."
