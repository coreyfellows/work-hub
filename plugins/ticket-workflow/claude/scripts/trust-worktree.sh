#!/usr/bin/env bash
# Mark worktree directories as trusted in ~/.claude.json, so `claude --bg`
# starts in them without the trust prompt. Claude Code keys trust on each
# path (a trusted parent does not cover subdirectories), so every worktree
# needs its own entry.
#
# Only paths under $TW_WORKTREES_ROOT (default ~/worktrees) are accepted. ~/.claude.json is backed up once
# per run and rewritten atomically.
#
# Usage: trust-worktree.sh <dir> [<dir>...]

set -euo pipefail

. "$(dirname "$0")/config.sh"
WORKTREES_ROOT="$TW_WORKTREES_ROOT"
CONFIG="${HOME}/.claude.json"

if [[ $# -eq 0 ]]; then
    echo "trust-worktree: give at least one directory" >&2
    exit 1
fi
if [[ ! -f "$CONFIG" ]]; then
    echo "trust-worktree: ${CONFIG} not found" >&2
    exit 1
fi

paths=()
for arg in "$@"; do
    dir=$(cd "$arg" 2>/dev/null && pwd -P) || {
        echo "trust-worktree: not a directory: $arg" >&2
        exit 1
    }
    root=$(cd "$WORKTREES_ROOT" && pwd -P)
    if [[ "$dir" != "$root"/* ]]; then
        echo "trust-worktree: refusing path outside ${WORKTREES_ROOT}: $dir" >&2
        exit 1
    fi
    paths+=("$dir")
done

cp -p "$CONFIG" "${CONFIG}.bak-trust-worktree"
tmp=$(mktemp "${CONFIG}.XXXXXX")
trap 'rm -f "$tmp"' EXIT

jq --args '
    reduce $ARGS.positional[] as $p (.;
        .projects[$p] = ((.projects[$p] // {}) + {hasTrustDialogAccepted: true}))
' "${paths[@]}" <"$CONFIG" >"$tmp"
# Keep the file's mode: GNU stat (Linux) first, since GNU `stat -f` means something else; BSD stat (macOS) otherwise.
mode=$(stat -c '%a' "$CONFIG" 2>/dev/null) || mode=$(stat -f '%Lp' "$CONFIG")
chmod "$mode" "$tmp"
mv "$tmp" "$CONFIG"
trap - EXIT

for p in "${paths[@]}"; do
    echo "trust-worktree: trusted $p" >&2
done
