#!/bin/bash
# Claude Code hook (PreToolUse / PostToolUse / PostToolUseFailure, matcher Bash): snapshots the git working tree
# of the command's cwd before and after, so work-hub can show what a sed/python/etc. command changed as diff cards
# (plugins/conversation-view/bash-snapshots/bashEdits.ts). The snapshot is a tree object built from a copy of the index (`git add -A` +
# `write-tree` with GIT_INDEX_FILE), so the repo's real index, HEAD and files are never touched; only objects are
# added. Writes $WORK_HUB_STATE_DIR/bash-snaps/<session>/<tool_use_id>.json (default ~/.local/state/work-hub). Never blocks or fails the tool.
#
# Cost control: commands that can't change the working tree (ls, grep, git status, gh pr view…) are skipped
# outright (classified in the same jq call that parses the input). The before-snapshot has to run inline (it must
# see the files before the command does); the after-snapshot runs in the background, and the next command's
# before-snapshot waits for any still in flight so one command's changes never land in another's card.
#   usage: bash-snapshot.sh pre|post   (hook JSON on stdin)
phase=${1:-}
input=$(cat)

# "snap" unless every command in the line is known not to write files. Unknown → snap (a miss only costs time).
read -r -d '' CLASSIFY <<'JQ'
def ro_words: ["ls","cat","head","tail","less","more","grep","egrep","fgrep","rg","ag","wc","echo","printf","pwd",
  "which","type","command","file","stat","du","df","date","jq","yq","tree","diff","cmp","basename","dirname",
  "realpath","readlink","sleep","true","false","test","[","[[","cd","pushd","popd","export","ps","pgrep","lsof",
  "whoami","id","uname","hostname","env","printenv","sort","uniq","cut","tr","column","nl","od","xxd","hexdump",
  "shasum","md5","sha256sum","base64","strings","man","sed","perl","find","curl","git","gh","claude","launchctl",
  "open","pbcopy","node","python3"];
def git_writes: ["checkout","switch","restore","reset","merge","pull","rebase","stash","apply","am","cherry-pick",
  "revert","mv","rm","clean","worktree","submodule","init","clone","sparse-checkout","lfs","format-patch","bisect"];
def seg_ro:
  sub("^\\s+"; "") | sub("^([A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)+"; "")
  | if . == "" or startswith("-") then true
    else (capture("^(?<w>\\S+)").w | sub("^.*/"; "")) as $w
    | if (ro_words | index([$w]) | not) then false
      elif $w == "sed" or $w == "perl" then test("\\s-[a-zA-Z]*i") | not
      elif $w == "find" then test("-(delete|exec|execdir|ok|fprint)") | not
      elif $w == "curl" then test("\\s(-[a-zA-Z]*[oO]|--output|--remote-name)") | not
      elif $w == "git" then
        (sub("^\\S+"; "") | gsub("\\s-[Cc]\\s+\\S+"; "") | [scan("\\s([a-z][a-z-]*)")[0]][0] // "") as $sub
        | (git_writes | index([$sub]) | not)
      elif $w == "gh" then test("\\b(checkout|clone|download)\\b") | not
      elif $w == "claude" then test("^\\S+\\s+(agents|logs|--version|-v)\\b")
      elif $w == "launchctl" then test("\\s(list|print)\\b")
      elif $w == "open" or $w == "pbcopy" then true
      elif $w == "node" or $w == "python3" then test("^\\S+\\s+(--version|-V|-v)\\s*$")
      else true end
    end;
def classify($c):
  ($c | gsub("[0-9]*>>?\\s*/dev/null|[0-9]*>&[0-9-]|&>\\s*/dev/null"; "")) as $d
  | if ($d | test(">")) then "snap"
    elif ([$d | splits("&&|\\|\\||[;|\\n&]|\\$\\(|`|[()]")] | all(seg_ro)) then "skip"
    else "snap" end;
[.session_id // "", .tool_use_id // "", .cwd // "", classify(.tool_input.command // "")] | @tsv
JQ

snapshot() { # sets tree and head for repo $top (index copied from $gitdir)
  local idx
  idx=$(mktemp "${TMPDIR:-/tmp}/wh-snap.XXXXXX") || return 1
  cp "$gitdir/index" "$idx" 2>/dev/null || : >"$idx"
  GIT_INDEX_FILE=$idx git -C "$top" add -A . >/dev/null 2>&1 &&
    tree=$(GIT_INDEX_FILE=$idx git -C "$top" write-tree 2>/dev/null)
  local ok=$?
  rm -f "$idx"
  head=$(git -C "$top" rev-parse -q --verify HEAD 2>/dev/null)
  return $ok
}

{
  IFS=$'\t' read -r session id cwd kind < <(jq -r "$CLASSIFY" <<<"$input") || exit 0
  [[ -n $session && -n $id && -d $cwd && $session != */* && $id != */* ]] || exit 0
  dir="${WORK_HUB_BASH_SNAP_DIR:-${WORK_HUB_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/work-hub}/bash-snaps}/$session"
  file="$dir/$id.json"

  if [[ $phase == post ]]; then
    [[ -f $file ]] || exit 0
    : >"$file.busy"
    (
      { read -r top; read -r gitdir; } < <(jq -r '.top, .gitdir' "$file")
      snapshot && jq --arg t "$tree" --arg h "$head" '. + {after: $t, headAfter: $h}' "$file" >"$file.tmp" && mv "$file.tmp" "$file"
      rm -f "$file.busy" "$file.tmp"
    ) </dev/null >/dev/null 2>&1 &
    disown
    exit 0
  fi

  [[ $kind == snap ]] || exit 0
  { read -r top; read -r gitdir; } < <(git -C "$cwd" rev-parse --show-toplevel --absolute-git-dir 2>/dev/null)
  [[ -n $top && -n $gitdir ]] || exit 0
  if [[ ! -d $dir ]]; then
    mkdir -p "$dir" || exit 0
    # A new session: drop snapshots older than two weeks.
    find "$(dirname "$dir")" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null
  fi
  # Let the previous command's after-snapshot finish first (normally done long before; give up after 3s).
  for _ in {1..30}; do
    compgen -G "$dir/*.busy" >/dev/null || break
    sleep 0.1
  done
  find "$dir" -name '*.busy' -mmin +1 -delete 2>/dev/null
  snapshot || exit 0
  jq -n --arg top "$top" --arg g "$gitdir" --arg t "$tree" --arg h "$head" '{top: $top, gitdir: $g, before: $t, head: $h}' >"$file"
} >/dev/null 2>&1
exit 0
