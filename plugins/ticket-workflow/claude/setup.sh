#!/usr/bin/env bash
# One-time setup for work-hub's bundled ticket-workflow plugin. Safe to rerun.
#   - writes work-hub's ticket-workflow config file ($WORK_HUB_TW_CONFIG, default
#     <work-hub config dir>/ticket-workflow.env) from config.env.example if it doesn't exist
#     (fill it in afterwards, or pass the common values as flags here)
#   - checks the tools the scripts need
# Usage: setup.sh [--jira-base-url <url>] [--jira-account-id <id>] [--jira-project <KEY>]
#                 [--jira-board-id <id>] [--worktrees-root <dir>]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/scripts/config.sh"
CONFIG="$TW_CONFIG_FILE"
SETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --jira-base-url) SETS+=("TW_JIRA_BASE_URL=${2:?--jira-base-url needs a value}"); shift 2 ;;
    --jira-account-id) SETS+=("TW_JIRA_ACCOUNT_ID=${2:?--jira-account-id needs a value}"); shift 2 ;;
    --jira-project) SETS+=("TW_JIRA_PROJECT=${2:?--jira-project needs a value}"); shift 2 ;;
    --jira-board-id) SETS+=("TW_JIRA_BOARD_ID=${2:?--jira-board-id needs a value}"); shift 2 ;;
    --worktrees-root) SETS+=("TW_WORKTREES_ROOT=${2:?--worktrees-root needs a value}"); shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# 1. Config file.
mkdir -p "$(dirname "$CONFIG")"
if [ ! -e "$CONFIG" ]; then
  cp "$HERE/config.env.example" "$CONFIG"
  echo "wrote $CONFIG"
else
  echo "kept existing $CONFIG"
fi
[ -r "$TW_STANDALONE_CONFIG_FILE" ] && echo "note: $TW_STANDALONE_CONFIG_FILE (a standalone ticket-workflow setup) is read too; values in $CONFIG win"
for kv in ${SETS[@]+"${SETS[@]}"}; do
  key="${kv%%=*}"; val="${kv#*=}"
  # Replace an existing (possibly commented-out) line, else append.
  tmp=$(mktemp)
  awk -v k="$key" -v line="$key=\"$val\"" '
    !done && ($0 ~ "^"k"=" || $0 ~ "^# *"k"=") { print line; done=1; next } { print }
    END { if (!done) print line }' "$CONFIG" >"$tmp"
  mv "$tmp" "$CONFIG"
  echo "set $key in $CONFIG"
done

# 2. Tools.
missing=0
check() { if command -v "$1" >/dev/null 2>&1; then echo "ok       $1"; else echo "missing  $1 ($2)"; missing=1; fi; }
check git "required"
check jq "required by the hooks and scripts"
check gh "for PR links"
[ "$missing" = 0 ] || echo "some tools are missing; see above"
