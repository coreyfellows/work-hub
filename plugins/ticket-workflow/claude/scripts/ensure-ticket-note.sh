#!/usr/bin/env bash
# Make sure a ticket's SilverBullet note exists ($TW_NOTES_DIR/tickets/<KEY>.md, created from a
# skeleton if missing) and print its URL ($TW_NOTES_URL/tickets/<KEY>; work-hub serves the notes at /notes
# on its own origin). Doesn't start or check the notes server: that's work-hub's notes plugin.
# Usage: ensure-ticket-note.sh <KEY> [--title <summary>] [--worktree <path>] [--path-only]
set -euo pipefail

KEY="${1:?usage: ensure-ticket-note.sh <KEY> [--title <summary>] [--worktree <path>] [--path-only]}"; shift
TITLE=""
WORKTREE=""
PATH_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:?--title needs a value}"; shift 2 ;;
    --worktree) WORKTREE="${2:?--worktree needs a value}"; shift 2 ;;
    --path-only) PATH_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
# Keys are always upper-case: the notes dir is usually on a case-insensitive volume, so tkt-1234 and
# TKT-1234 would be the same file but different SilverBullet pages.
KEY=$(tr a-z A-Z <<<"$KEY")
[[ "$KEY" =~ ^[A-Z][A-Z0-9]+-[0-9]+$ ]] || { echo "ensure-ticket-note: '$KEY' isn't a ticket key" >&2; exit 1; }

. "$(dirname "$0")/config.sh"
NOTE="$TW_NOTES_DIR/tickets/$KEY.md"
JIRA_URL=""
[ -z "$TW_JIRA_BASE_URL" ] || JIRA_URL="$TW_JIRA_BASE_URL/browse/$KEY"
mkdir -p "$(dirname "$NOTE")"
if [ ! -e "$NOTE" ]; then
  cat > "$NOTE" <<EOF
---
tags: ticket
ticket: $KEY
jira: ${JIRA_URL}
worktree: ${WORKTREE}
created: $(date +%Y-%m-%d)
---
# $KEY${TITLE:+: $TITLE}
${JIRA_URL:+
[Jira]($JIRA_URL)
}
## Scripts

## Manual steps

## Context
EOF
fi

if [ "$PATH_ONLY" = 1 ]; then echo "$NOTE"; exit 0; fi
echo "$TW_NOTES_URL/tickets/$KEY"
