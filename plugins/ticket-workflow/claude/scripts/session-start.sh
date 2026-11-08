#!/usr/bin/env bash
# SessionStart hook: add the ticket-workflow policy (policy.md, written for sessions work-hub starts) to the context.
# Turn it off with TW_INJECT_POLICY=0 in the config file.
set -euo pipefail
. "$(dirname "$0")/config.sh"
[ "$TW_INJECT_POLICY" = 1 ] || exit 0

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
POLICY=$(sed -e "s#@PLUGIN_ROOT@#$ROOT#g" -e "s#@CONFIG_FILE@#$TW_CONFIG_FILE#g" "$ROOT/policy.md")
jq -n --arg ctx "$POLICY" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
