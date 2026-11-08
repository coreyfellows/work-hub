# git-cards (a conversation-view feature)

Git commands a session ran through Bash, drawn in the conversation as cards (commits with their files, staging, removals,
pushes, merges…) instead of being folded into "⋯ N steps".

## How ops are found

- **Parsing** (`gitOps.ts`, `parseGitOps`): each Bash command line is split into segments (quotes respected, heredoc bodies
  skipped, `cd X &&` and `git -C X` followed, redirections dropped) and turned into ops on the entry's `git` field: commit, rm,
  mv, restore, push, pull, merge, rebase, reset, checkout/switch, stash, cherry-pick, revert, tag, branch, worktree… Read-only
  git and `git add` are ignored.
- **Resolving** (`resolveGitOps`): once the call has a result (`doneAt`), commits and other HEAD moves come from that repo's
  reflog within [call − 1.5s, result + 1.5s] (so `commit -q` works; files from name-status/numstat vs the first parent), and
  push refs from the command's output.
- Both run in the plugin's transcript enricher `git` (`server.ts`, `ctx.transcript.addEnricher`). The core types
  `HistoryEntry.git` opaquely (`GitOpsField`); this plugin narrows it to its own `GitOp[]` (`types.ts`).

## Route

`GET /api/sessions/:id/commit-diff?dir&sha` (ETag-revalidated through `ctx.revalidate`): `{ files: FileEdit[] }`, the commit's
changes vs its first parent (a root commit vs the empty tree) as `-U2` hunks (`commitDiff` + plugin-api's `parseDiff`, the
same diff parser bash-snapshots uses). It only serves a commit that session's log shows (same repo dir and sha, found by paging through
`ctx.sessions.readHistory`); anything else is 404 "commit not in this session". Fetched only when a commit's modal opens.

## Slot

`log-card` item `git`, `order: 20` (after the file-change cards of `edit-cards` at 10, so one call's edit cards come
before its git card):
- `GitCard.tsx` shows one row per op (git-orange edge). Ones with files, refs or moves open them in the shared `Modal`; a
  commit's modal is the core `FilesBrowser` (tree + diff, the same as grouped edits), its diffs fetched from the route above.
- In Chat, git ops of consecutive calls share one card (the `run` rule: other tool steps between them don't break it). A commit
  directly followed by a merge and/or push is one "Committed, merged & pushed" row (`repo → target`), and two or more rows in a
  run collapse into one `GitGroup` card ("Git  Committed, pushed  N actions"; its modal has a picker over the actions).
- The Log shows the card inside the Bash call's row; no runs there.

The `.git-st` status-letter colours stay in the core stylesheet, because the core `FilesBrowser` draws them for every file tree.

## Settings

None.
