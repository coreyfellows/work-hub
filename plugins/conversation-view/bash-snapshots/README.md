# bash-snapshots (a conversation-view feature)

On by default: turn it off with the conversation-view setting `bashSnapshots: false` (plugins.json `settings`, or the env var
`WORK_HUB_CONVERSATION_VIEW_BASH_SNAPSHOTS=1`). Shows the files that commands changed (sed, python, formatters…) as the same diff cards an Edit call gets.
Claude's transcript doesn't record those changes, so a Claude Code hook snapshots the git working tree around each Bash
call and the plugin diffs the two snapshots.

## How it works

- `claude/hooks/bash-snapshot.sh` is a Claude Code Pre/PostToolUse/PostToolUseFailure hook (matcher `Bash`). It snapshots the
  cwd's git working tree before and after as tree objects (a copy of the index + `add -A` + `write-tree` under
  `GIT_INDEX_FILE`, so the real index is untouched) into `<dir>/<session>/<tool_use_id>.json`.
- `bashEdits.ts` (the `bash-edits` transcript enricher, `resolve` step) diffs them (`-U2`, each hunk becomes old/new) once the
  call has a result, and puts one entry per file on the history entry's `edits`. The cards themselves are drawn by the
  `edit-cards` feature. Skipped when HEAD moved (checkout/pull/merge) or more than 20 files changed; only files in the cwd's
  repo are seen.
- The snapshot folder `dir` (setting `bashSnapshotsDir`, or the env var `WORK_HUB_BASH_SNAP_DIR`) defaults to
  `<state dir>/bash-snaps`.

## Cost

The hook's jq call classifies the command first. Ones that can't touch the working tree (ls, grep, `sed -n`, git
status/log/diff/commit/push, gh views…; any `>` redirect or unknown command counts as writing) are skipped. The before-snapshot
runs inline (~0.3s). The after-snapshot runs in the background with a `<id>.json.busy` marker that the next call's
before-snapshot waits on (up to 3s), so changes are never attributed to the wrong command. Cards attach to their own tool
entry, so the log order is always the call order however late a snapshot lands.

## Enabling the hook

1. Per session (default when the feature is on): every `claude --bg` session the app starts gets
   `--settings '{"hooks": …}'` (a launch-args contribution), with `WORK_HUB_BASH_SNAP_DIR` pinned to `dir`. Nothing is written to
   your Claude settings, and sessions you start yourself don't get it.
2. In every session, opt-in: `plugins/conversation-view/bash-snapshots/setup/install-bash-hook.sh` registers the hook in `~/.claude/settings.json`
   (`CLAUDE_SETTINGS_FILE` overrides the file) with the command prefixed by `WORK_HUB_STATE_DIR=<state dir>` (set that
   variable first if the app uses a non-default state dir; the folder is then `<state dir>/bash-snaps`), or, with
   `--dir <path>`, by `WORK_HUB_BASH_SNAP_DIR=<path>` (use that when you set `bashSnapshotsDir`). Any existing entry that
   runs a `bash-snapshot.sh`, from this checkout or another one (an older or moved copy), is replaced, so there is only
   ever one. It is a dry run by default (prints the diff); `--apply` writes, `--remove` takes the hook out. It does not
   commit anything.

**Both at once.** If your settings already run a `bash-snapshot.sh` hook that writes to `bashSnapshotsDir`, sessions the
app starts would run it twice per Bash call (racing on the same `<id>.json`, `.tmp` and `.busy`). So before each launch the
plugin reads (never writes) that settings file (`CLAUDE_SETTINGS_FILE`, else `$CLAUDE_CONFIG_DIR/settings.json`, else
`~/.claude/settings.json`; the setting `bashSnapshotsClaudeSettings` overrides it) and skips its `--settings` when such a hook is
there (`globalHook.ts`). The server log says once which path is active, and again when that changes: "using the global
hook" or "per-session (--settings)". A global hook that writes to a different folder doesn't count (the app wouldn't see
its snapshots): the per-session hook is added as well, with a warning naming both folders.

Needs `jq` and `git` on the PATH. Interactive sessions started outside the app only get snapshots with option 2, and only
sessions whose transcript the app reads show the cards.
