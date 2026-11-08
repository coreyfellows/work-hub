# session-awareness

Gives every session in a workspace a short, server-derived picture of its sibling sessions: what each is responsible
for, where it works, which PRs it owns, what it has finished, and when two of them touch the same files. Nothing is
summarised by a model and no session reads another's transcript: the digest is built from facts work-hub already
tracks, and a session hears about it only when something changed. Design:
`docs/superpowers/specs/2026-11-06-session-awareness-design.md`.

## The digest

One per workspace, a block per open session (recorded in the workspace, still listed by `claude agents`, not done or
stopped; failed ones stay). Each block, lines omitted when empty, capped at `maxBlockChars` (digest at 4 000):

| line | from |
| --- | --- |
| short id, name, role, status, started / last active (coarse buckets) | the `claude` source and the workspace's session record |
| intent | the job's `intent`; an app-started session's intent is its whole start prompt, so only its "Your task:" first line is kept |
| responsible for | the session's latest `claim` event (`wh claim`) |
| done (last 3) | its `done` events (`wh done`) |
| worktree, branch → base | the recorded worktree it runs in, else the first one reconcile bound it to |
| PRs on that branch (state, checks) | the github plugin's lists when it is on (matched by repo + branch) |
| last 3 commits on the branch | `git log <base>..HEAD` in the worktree, cached by HEAD |
| files edited lately, "also edited by" | the transcript's Edit/Write records (`sessionEdits`), overlaps across sessions by repo-relative path within the last 2 h |

Trimming when over the cap: oldest dones, then commits, then the intent, then files (the overlap signal goes last).
Each block carries a `version` hash of its facts (time buckets excluded), so readers know what changed.

**When it is rebuilt** (never on a timer): `session-started` / `session-stopped`, every `workspace-event` the server
logs, `source-changed` for `claude` (also dates the live facts) and `github`, and a file watch on `hub.db` /
`hub.db-wal`, because `wh` writes the database from its own process and the `workspaces` source only polls while a tab
is watching. Rebuilds are debounced ~2 s per workspace and run one at a time; an unchanged digest isn't rewritten.

**Staleness is stamped, never hidden.** Status and PR facts only refresh while the `claude` source runs (a watching
tab, or the keep-awake plugin's own refresh). When they are older than `staleAfterMs`, prompts, nudges and the
Details section say "status as of 2h ago: work-hub was idle"; the hook also drops status-based lines then. Claims,
dones, links, worktrees and commits are always current (the DB watch).

Files, under `<state dir>/plugins/session-awareness/`: `digests/<workspace>.json` and `.md`, `sessions/<session>.json`
(→ `{ workspaceId }`, so the hook finds its workspace), `seen/<session>.json` (written by the hook only).

## How a session gets it

- **At start:** a `session-context` fragment adds "## Other sessions in this workspace" with the digest to the prompts
  of new, handoff, PR and review sessions (`startPrompt` setting); a handoff leaves out the session it replaces. The
  explorer gets none.
- **While running:** `claude/hooks/awareness.mjs`, passed to app-started sessions as an inline `--settings` hook
  (`hookSettings.ts`: the command pins the state folder, since `claude --bg` jobs don't inherit the server's
  environment, and runs on the server's own `node`). On `UserPromptSubmit`, and on `PreToolUse` (only for `Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task`, so reads
  don't start a process) at most once per `nudgeIntervalMs`, it compares the digest with what this session last saw and adds only change lines (`changes.mjs`:
  a new sibling, a failure, waiting on the user, a new PR, checks flipped, a new claim, something finished, a new
  overlap, a sibling gone; at most 5, then a trailer). Its first run only records what the start prompt already
  carried. It never calls the server, exits 0 silently on any problem, and prints nothing when nothing changed.
- **On demand:** `claude/scripts/team.sh <ws>` (and `team.ps1`) prints the digest Markdown; the rules fragment names
  the full command. Hand-started sessions get only this.
- **Rules:** a `workspace-rules` fragment tells every workspace session to `wh claim <ws> "<what you own>"` (latest
  wins) and `wh done <ws> "<what you finished>"`. Both are core `wh` commands; events carry the calling session's id
  (`CLAUDE_CODE_SESSION_ID`, a subagent's job, or `--session`), see CHANGELOG 2026-11-06.

## Routes and slots

- `GET /api/plugins/session-awareness/workspaces/:id/digest` → the digest JSON (404 before the first build);
  ETag-revalidated.
- `workspace-section` "Sessions at a glance" (`SessionsGlance.tsx`, order 25): one card per session (status dot, name
  linking to the session, claim or intent, worktree and branch, PRs with the checks glyph, done lines, edited files with
  "also …" for overlaps), plus the staleness sentence. Hidden for workspaces with fewer than two sessions. Loads when
  shown; with Low data off it follows the `claude` / `workspaces` sources (debounced 2.5 s); with Low data on it loads
  once and shows "as of … ↻".

## Settings (`WORK_HUB_SESSION_AWARENESS_<KEY>` env or Settings → Plugins → Session awareness)

| key | default | meaning |
| --- | --- | --- |
| `nudgeIntervalMs` | 300000 | PreToolUse checks at most this often per session; 0 = UserPromptSubmit only (read per launch) |
| `maxBlockChars` | 600 | the longest a session's block renders to |
| `startPrompt` | true | add the digest to new sessions' start prompts |
| `staleAfterMs` | 600000 | live facts older than this are stamped as stale |
| `rebuildDebounceMs` | 2000 | wait this long after a change before rebuilding a workspace's digest (read at startup) |

Turning the plugin off removes the fragments, the hook (next launches), the route and the section; `wh claim` / `wh
done` keep working (core) and keep logging events.

## Caveats

- A nudge reaches a session on its next user prompt, or at the next tool call once the interval has passed; a turn
  that makes no tool calls hears nothing until the next prompt.
- Without the keep-awake plugin and with no tab open, session status in the digest goes stale (and says so); claims,
  dones and links don't.
- Linux: untested beyond the test suite. Windows: experimental and never run there (the hook's command line uses a
  POSIX `ENV=value cmd` prefix, which `cmd.exe` does not understand; `team.ps1` is `team.sh`'s twin). Whoever runs it
  there fixes what breaks and commits it back.
- The `.md` digest file is rendered without excluding anyone and stamped relative to its build time; prompts and the
  hook render from the `.json` with the asker left out.
