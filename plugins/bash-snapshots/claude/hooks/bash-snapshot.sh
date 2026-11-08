#!/bin/bash
# Forwarder for the old hook path (the bash-snapshots plugin became a feature of conversation-view). Global hooks in
# ~/.claude/settings.json written by an older install-bash-hook.sh still point here. Re-run
# plugins/conversation-view/bash-snapshots/setup/install-bash-hook.sh --apply to point them at the real file, then
# delete this folder.
exec "$(cd "$(dirname "$0")" && pwd)/../../../conversation-view/bash-snapshots/claude/hooks/bash-snapshot.sh" "$@"
