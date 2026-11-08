#!/usr/bin/env bash
# Print the current digest of a workspace's sessions (the Markdown work-hub's session-awareness plugin keeps on disk),
# for a session that wants the picture on demand. Usage: team.sh <workspace-id>
# The folder comes from WORK_HUB_SESSION_AWARENESS_DIR (the rules line the plugin writes sets it), else the default
# state dir: ${WORK_HUB_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/work-hub}/plugins/session-awareness.
set -euo pipefail

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "usage: team.sh <workspace-id>" >&2
  exit 2
fi
ws="$1"
dir="${WORK_HUB_SESSION_AWARENESS_DIR:-${WORK_HUB_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/work-hub}/plugins/session-awareness}"
file="$dir/digests/$ws.md"
if [ -s "$file" ]; then
  cat "$file"
  # the Markdown has no trailing newline when it ends with a block line
  [ "$(tail -c 1 "$file" | od -An -c | tr -d ' ')" = '\n' ] || echo
else
  echo "work-hub: no other sessions recorded for $ws"
fi
