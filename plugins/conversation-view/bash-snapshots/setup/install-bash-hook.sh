#!/bin/bash
# Opt-in, for people who want the snapshot hook in EVERY Claude session (not only the ones work-hub starts, which get it
# per session when the bash-snapshots plugin is on). Registers claude/hooks/bash-snapshot.sh in ~/.claude/settings.json
# (PreToolUse, PostToolUse, PostToolUseFailure; matcher Bash). The command is prefixed with WORK_HUB_STATE_DIR=<dir> so the
# hook writes where the server reads: <dir>/bash-snaps (default dir: $WORK_HUB_STATE_DIR, else
# ${XDG_STATE_HOME:-~/.local/state}/work-hub; set WORK_HUB_STATE_DIR before running to use another).
# --dir <path> pins the snapshot folder itself instead (WORK_HUB_BASH_SNAP_DIR=<path>; use the plugin's `dir` setting).
# Any existing entry running a file named bash-snapshot.sh (e.g. a copy in an older or moved checkout) is replaced, so
# there is only ever one. Dry run by default: prints the resulting settings diff. --apply writes it; --remove takes the
# hooks out again.
set -euo pipefail

usage() { echo "usage: $0 [--apply|--remove] [--dir <snapshot folder>]" >&2; exit 2; }
mode=dry
dir=
while (($#)); do
  case "$1" in
    --apply) mode=apply ;;
    --remove) mode=remove ;;
    --dir) [[ $# -ge 2 && -n $2 ]] || { echo "--dir needs a path" >&2; usage; }; dir=$2; shift ;;
    --dir=*) dir=${1#--dir=}; [[ -n $dir ]] || { echo "--dir needs a path" >&2; usage; } ;;
    *) usage ;;
  esac
  shift
done

settings="${CLAUDE_SETTINGS_FILE:-$HOME/.claude/settings.json}"
hook="$(cd "$(dirname "$0")/../claude/hooks" && pwd)/bash-snapshot.sh"
state="${WORK_HUB_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/work-hub}"
[[ -f $settings ]] || { echo "no $settings" >&2; exit 1; }
[[ -x $hook ]] || { echo "missing or not executable: $hook" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
if [[ -n $dir ]]; then
  [[ $dir == /* ]] || dir="$PWD/$dir"
  prefix="WORK_HUB_BASH_SNAP_DIR='$dir'"
else
  prefix="WORK_HUB_STATE_DIR='$state'"
fi
[[ $state != *\'* && $hook != *\'* && $dir != *\'* ]] || { echo "paths with a single quote aren't supported" >&2; exit 1; }

new=$(mktemp)
trap 'rm -f "$new"' EXIT
# Drop every existing entry that runs a bash-snapshot.sh (this checkout's or any other's, whatever prefix), then (unless
# removing) add one per event.
jq --arg hook "$hook" --arg prefix "$prefix" --arg mode "$mode" '
  "\($prefix) '"'"'\($hook)'"'"'" as $cmd
  | .hooks //= {}
  | reduce ("PreToolUse", "PostToolUse", "PostToolUseFailure") as $ev (.;
      .hooks[$ev] = [(.hooks[$ev] // [])[]
        | select(any(.hooks[]?; (.command // "") | test("(^|[\\s/\u0027\"])bash-snapshot\\.sh([\u0027\"\\s]|$)")) | not)])
  | if $mode == "remove" then .
    else
      .hooks.PreToolUse += [{matcher: "Bash", hooks: [{type: "command", command: "\($cmd) pre", timeout: 15}]}]
      | .hooks.PostToolUse += [{matcher: "Bash", hooks: [{type: "command", command: "\($cmd) post", timeout: 15}]}]
      | .hooks.PostToolUseFailure += [{matcher: "Bash", hooks: [{type: "command", command: "\($cmd) post", timeout: 15}]}]
    end
  | .hooks |= with_entries(select(.value != []))
' "$settings" >"$new"

if diff -q "$settings" "$new" >/dev/null; then
  echo "Nothing to change."
  exit 0
fi
diff -u "$settings" "$new" || true

if [[ $mode == dry ]]; then
  echo
  echo "Dry run. Re-run with --apply to write this (or --remove to take the hook out)."
  exit 0
fi

cp "$new" "$settings"
echo "Done. New Claude sessions pick it up; running ones on their next settings reload."
