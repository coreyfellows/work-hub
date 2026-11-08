# Session awareness: sibling sessions know what each other is doing

A workspace often has several Claude sessions open at once (an explorer, a main session, a review, a spin-off for a
separate PR). Today each one only knows what its own prompt said. This change gives every session in a workspace a
cheap, current picture of its siblings: what each is responsible for, where it works, which PRs it owns, what it has
finished, and when two of them touch the same files.

The owner's one hard constraint: **it must not burn tokens.** No session reads another's transcript, no model
summarises anything, and nothing is added to a session's context when nothing has changed.

## Goals

- Every session work-hub starts in a workspace knows, from its first turn, what the other open sessions in that
  workspace are doing, in a compact form (a few lines per sibling).
- When a sibling does something that matters mid-task (opens a PR, finishes, fails, claims a responsibility, starts
  editing files this session also edits), the session learns about it on its next turn, as a few lines, and only then.
- The picture is **derived by the server** from what work-hub already tracks. A session may add to its own entry with
  two short `wh` lines; nothing depends on it doing so.
- The user can see the same picture on the workspace page.
- Works with Low data on and with the GitHub plugin off (PR facts are simply absent).

## Non-goals and anti-goals

- No model-written summaries, no reading sibling transcripts, no embeddings. Facts only, from the store, git and the
  transcript scans the core already does.
- No cross-workspace awareness. A session only sees its own workspace.
- No messaging between sessions. This is a shared noticeboard, not a channel. (A session that needs to tell a sibling
  something still uses the existing route: its own PR, note or `wh note`.)
- Not a planner: it never assigns work or tells a session to stop.
- Failure modes that would make this a failure even if it works: a nudge on every turn when nothing changed, the digest
  growing without bound, or a session being told something stale as if it were current.

## Shape

A new official plugin, `session-awareness` (`plugins/session-awareness/`, `defaultEnabled: true`), plus a handful of
small additive core changes listed under "Core changes" (a session column on workspace events, two `wh` subcommands,
and the store surface the plugin needs through `plugin-api`). The plugin:

1. keeps one **digest** per workspace: one block per session, rebuilt from facts when something changes;
2. writes the digest to disk, where a Claude Code hook (passed only to app-started sessions) reads it;
3. adds the digest to the start prompt of new workspace sessions and the `wh claim` / `wh done` lines to the rules;
4. serves it to the UI as a Details section.

### The digest

One per workspace, JSON on disk plus a Markdown rendering. Blocks are keyed by session id and each block carries a
`version` (a hash of its rendered text) so readers can tell what changed without diffing.

Which sessions are in it: every session recorded in the workspace that `ctx.sessions.list()` still returns (hidden
sessions, such as plugins' headless helpers, are already left out of that list) and that is not done or stopped (the
same `HIDDEN` statuses the workspace tabs leave out), plus unassigned-but-adopted ones once reconcile has added them.
Failed sessions stay (their last state matters to siblings).

Each block, every line optional and omitted when empty:

| line | from |
| --- | --- |
| id, name, role, status (working, waiting on you, idle, failed) and "started 2h ago" / "last active 5m ago" | the `claude` source and the workspace's session record |
| intent | `Session.intent` (the job's state.json) |
| "responsible for: …" | the latest `claim` event this session logged (see `wh claim`) |
| "done: …" (last 3) | `done` events this session logged |
| worktree, branch → base | the worktrees the session started in or is bound to (`session_worktrees`) |
| PRs on that branch: `#41 "title" (open, checks green/red/pending)` | the github plugin's PR lists when it is active (`ctx.services.get('github').data()`: `mine`, `reviewRequested`, with `repo`, `branch`, `number`, `title`, `url`, `isDraft`, `checks`), matched by repo + branch the way `prLinks.ts` does; otherwise the workspace's `pr` links whose `link` event this session logged (see `wh link add` under "Core changes") |
| last commits on the branch not on base (up to 3, short sha + subject) | `git log base..HEAD` in the worktree, cached by HEAD sha |
| files edited lately (up to 8 distinct paths, repo-relative) | `ctx.sessions.sessionEdits` on the session's transcript, cached by transcript size |
| "also edited by: 3f2a" after a path | computed across blocks: a path in two open sessions' edited lists |

Size caps (the builder may tune them, the point is a bound): a block renders to at most ~600 characters, a workspace
digest to at most ~4 000; when over, drop oldest "done" lines, then commits, then edited files. Paths are shown relative
to the worktree.

**When it is rebuilt.** Never on a timer, and never by polling anything new. Triggers:

- the in-process events `session-started`, `session-stopped` and `workspace-event` (the server's own `logEvent` calls:
  reconcile's adoptions, github's `link` events, routes);
- `source-changed` for the `claude` and `github` sources (status flips, PR lists; these only fire while a tab is
  watching, by the registry's rule);
- **a change to `hub.db` on disk.** `wh` runs in its own process, so its `logEvent` never reaches the server's event
  bus and the `workspaces` source is only polled while a tab is watching. The plugin therefore watches the database
  files (`hub.db` and `hub.db-wal`, `fs.watch`, debounced) and rebuilds the digests of workspaces whose event count or
  latest event changed. This is a file watch, not a poll: free, no tokens, and it catches every `wh claim`, `wh done`,
  `wh link add` and `wh worktree add` from any session, tab or no tab.

Each trigger rebuilds the affected workspace's digest after a short debounce (~2 s). A rebuild that produces the same
block versions writes nothing. The inputs are all local and free of tokens; the only spawned work is `git log` per
worktree, and only when its HEAD sha moved.

**Staleness is stamped, never hidden.** The owner chose this over a background timer: with no tab watching, session
status and PR facts stop updating (that is the app's token rule), so the digest must say so. Each block carries the
time its live facts (status, PRs) were last refreshed, and the whole digest a `builtAt`. The hook and the start prompt
add "(status as of 2h ago: work-hub was idle)" to a block whose live facts are older than `staleAfterMs` (setting,
default 10 minutes), and the hook does not report a status change it cannot vouch for. Facts that come from the DB and
git (claims, dones, links, worktrees, commits) are always current, because the DB watch keeps them so.

The `claude` source changes often (status flips), so block versions must not include anything that flips without
meaning: "last active" is bucketed (just now, 5m, 30m, 2h, today, older), status is the normalised one, and the
refresh times are not part of the version.

**Where it lives.** `<pluginState>/digests/<workspaceId>.json` and `.md`, written atomically (temp file + rename). Also
`<pluginState>/sessions/<sessionId>.json` → `{ workspaceId }` for each session in a digest, so a hook can find its
workspace from the session id Claude Code gives it. The hook never calls the server over HTTP (the guard and the
hostname/auth modes would make that fragile); it reads files, like the bash-snapshot hook does.

### Sessions adding to their own block

Two new core `wh` subcommands, so sessions don't need another tool:

- `wh claim <ws> "<what I'm responsible for>"`: this session's current responsibility. The latest one wins; it replaces
  the previous claim in the digest (history stays in the activity log).
- `wh done <ws> "<what I finished>"`: appended; the digest shows the last three.

Both log a workspace event (`claim`, `done`) through the existing `logEvent`, with one addition: **events get a
nullable `session_id` column** (core migration) holding the **full Claude session UUID**, the same id as
`sessions.claude_session_id`, so it joins to workspace sessions directly. `wh` fills it, in this order:

1. `--session <uuid>` when given;
2. `CLAUDE_JOB_DIR`'s basename when `CLAUDE_CODE_CHILD_SESSION` is set (a subagent: its own `CLAUDE_CODE_SESSION_ID`
   is the child's, which no workspace knows), resolved to the UUID through `~/.claude/jobs/<id>/state.json`
   (`sessionId`), the way `startBackgroundSession` already does. A job id is not the UUID's prefix, so it is never
   stored as-is;
3. `CLAUDE_CODE_SESSION_ID` (set in every Bash call a session makes, interactive or background; verified);
4. `CLAUDE_JOB_DIR` resolved as in 2;
5. else unattributed: the event shows under the workspace rather than a session.

`wh log` and `wh link add` gain the same attribution (`wh link add` logs a `link` event today only when github's
reconcile pass adds the link; `addLink` itself logs nothing, so `wh link add` starts logging one). The activity log in
the UI may show the session's short id beside attributed entries (small, optional polish).

The rules every workspace session ends with (`workspace-rules` fragment from this plugin) say, in two lines: claim what
you take on with `wh claim`, record what you finish with `wh done`, and that the "Other sessions" block in your context
is kept by work-hub and refreshed when something changes. The owner chose this as an addition to the derived facts, not
the source of truth: nothing breaks when a session never runs them.

### How a session gets it

**At start.** A `session-context` fragment appends the workspace's digest (Markdown) under a heading
"Other sessions in this workspace". Today only the new-session prompt (`builtin/session-tools/sessions.ts`, through
`ctx.prompts.workspaceContext`) and adversarial-review's review session join `session-context` fragments; handoff
(`builtin/session-tools/handoff.ts`) and PR sessions (`plugins/github/prSession.ts`) append `workspaceRules` only. Both
of those start appending `ctx.prompts.fragments('session-context', { workspaceId, ticketKey })` after their own context
(a two-line change each, part of this work), so all four kinds start with the digest. The explorer does not (it starts
the workspace; there are no siblings yet). The starting session's own block is left out. Nothing is added when there
are no other sessions.

**While running.** A Claude Code hook, passed to app-started sessions through `ctx.sessions.addLaunchArgs` as an
inline `--settings` hooks entry whose command names the script and the state folder explicitly
(`WORK_HUB_SESSION_AWARENESS_DIR=<pluginState> node <plugin>/claude/hooks/awareness.mjs`), the way bash-snapshots
passes its hook (`hookSettings.ts`). Not `--plugin-dir` with a static `hooks.json`: `claude --bg` jobs don't inherit
the server's environment, so a static hook could not find a non-default `WORK_HUB_STATE_DIR`. The core already merges
several plugins' `--settings` into one. The hook is a Node script, not bash + jq, so it runs on every platform the app
does.

- Event: `UserPromptSubmit`, always. Also `PreToolUse` for every tool, throttled: it does its check at most once per
  `nudgeIntervalMs` (setting, default 5 minutes), so a long autonomous turn still hears about a sibling's PR.
- What it does: read `sessions/<session_id>.json` for the workspace id (exit silently if none: a hand-started or
  unassigned session), read the digest, compare each sibling block's `version` with the per-session seen file
  `<pluginState>/seen/<sessionId>.json` (written only by the hook), and emit `additionalContext` only for blocks that
  are new or changed, then record them as seen. Its own block is never reported.
- What it says: not the whole block, a change line per sibling, at most ~5 lines total, with the full block only for a
  new session. Example: `work-hub: session 3f2a (Add PR button) opened PR #41 on feat/pr-button; checks pending.` or
  `work-hub: session 9c1d edited server/registry.ts, which you also edited.` Change lines are computed by the hook from
  the previous and current block JSON (PR set, status, claim, done list, edited files overlapping this session's). When
  more than ~5 things changed, it says so and points at the full digest file.
- Cost: nothing when nothing changed (the common case). The check itself is a few file reads, under 50 ms.
- On any error (missing file, bad JSON), exit 0 with no output. The hook must never block a turn.

**On demand.** `claude/scripts/team.sh <ws>` (and `.ps1` twin, per the platform rules) prints the digest Markdown,
for a session started by hand. The rules fragment names the full path. Hand-started sessions get nothing else: they
have no app-written start prompt and are not passed the hook.

### The user's view

A `workspace-section` item, **"Sessions at a glance"**, in Details: the digest
rendered as one compact card per session (status dot, name, responsibility, branch and PRs as links, done lines, edited
files with an "also edited by" marker). It reads `GET /api/plugins/session-awareness/workspaces/:id/digest` (registered
with `ctx.revalidate`, so unchanged polls are 304), loads when the section opens and whenever the `workspaces` or
`claude` source changes while the section is visible; with Low data on it loads on open only and shows `<AsOf>` with ↻.
`isEmpty` when the digest has fewer than two blocks, so single-session workspaces don't grow a section.

No new page, no new palette command (the section is enough; the builder may add "Show sessions at a glance" if trivial).

## Settings

Declared in the manifest (`settings`), read with `ctx.config.get`:

| key | env | default | what |
| --- | --- | --- | --- |
| `nudgeIntervalMs` | `WORK_HUB_SESSION_AWARENESS_NUDGE_INTERVAL_MS` | 300000 | how often the PreToolUse check may run per session (0 = UserPromptSubmit only) |
| `maxBlockChars` | `WORK_HUB_SESSION_AWARENESS_MAX_BLOCK_CHARS` | 600 | per-session block cap |
| `startPrompt` | `WORK_HUB_SESSION_AWARENESS_START_PROMPT` | true | add the digest to new sessions' start prompts |
| `staleAfterMs` | `WORK_HUB_SESSION_AWARENESS_STALE_AFTER_MS` | 600000 | live facts older than this are stamped "as of …" in prompts and nudges |

Turning the plugin off removes the fragments, the hook (via `addLaunchArgs`), the route and the section; existing
sessions just stop getting nudges. The `wh claim`/`wh done` commands still work (they are core) and still log events.

## Core changes (all additive, no `apiVersion` bump)

The plugin must not run raw SQL on core tables or import core internals, so what it needs that `plugin-api` lacks is
added there:

- Migration: `events.session_id TEXT` (nullable). `logEvent(wsId, type, detail?, sessionId?)`.
- `store.listEvents(wsId, { types?, sessionId?, limit? })`: today `Workspace.events` is the last 20 rows, unfiltered,
  which is not enough to find a session's latest claim.
- `ctx.sessions.boundWorktrees(sessionId)` (or `store.boundWorktrees`): `server/store/sessionWorktrees.ts` isn't
  reachable from plugins today.
- `wh claim`, `wh done`; attribution (above) on them and on `wh log` and `wh link add`; `wh link add` logs a `link`
  event.
- `handoff.ts` and github's `prSession.ts` append `session-context` fragments (above).
- CHANGELOG entry for all of it.

## Constraints and rules this must respect

- Plugin boundary: imports only from `plugin-api/*`, npm and its own folder; core never imports it. Add any new core
  route to `CORE_ROUTES` if one is needed (none is planned).
- Token budget: the plugin registers no source and no timer; everything is event-driven (in-process events, source
  changes, the database file watch). The hook spends no tokens on a quiet workspace.
- Low data: the Details section is a polled GET with ETag and `<AsOf>`; nothing streams.
- Security: no new network listener; the hook reads files under the state dir (0700). The route sits behind the guard
  like every plugin route.
- Platforms: the hook is Node; the on-demand script has a PowerShell twin; paths through `normPath` where compared.
  Say in the README that the Windows half is untested, per the project rule.
- Mobile: the section's cards wrap; long paths and PR titles truncate with ellipsis inside their box.
- Tests (`plugins/session-awareness/*.test.ts`): digest building from fixture sessions/events (blocks, caps, overlap,
  stable versions across status flips), the hook's change-line computation (pure function over previous/current JSON),
  seen-file handling, and the `wh` attribution from `CLAUDE_CODE_SESSION_ID` and `CLAUDE_JOB_DIR`. The core migration gets a line in the store
  tests.
- Docs: plugin README (routes, slots, settings, the hook, caveats), a row in CLAUDE.md's plugin table, a CHANGELOG entry
  (additive: new `wh` subcommands, `events.session_id`, `listEvents`, `boundWorktrees`, no `apiVersion` bump).

## Left to the builder

- Exact JSON schema of the digest and seen files; the change-line wording; the debounce and cache details.
- Whether the PreToolUse hook matches every tool or just Bash/Edit/Write (every tool is the intent; narrow it only if
  Claude Code's matcher makes that cheaper).
- Where in Details the section sits by default (`order`), and the card layout.
- How "also edited by" treats files edited long ago (my suggestion: only edits from the last ~2 hours count, so a
  session's early scaffolding doesn't flag every sibling forever).

## Decided by the owner

- Timing: the digest at start, plus nudges on changes (not every turn, not on demand only).
- Source: derived by the server, plus a session's own `claim`/`done` lines.
- Freshness without a watching tab: watch the database file and stamp staleness on live facts; no background timer.

## Calls made without the owner (check these)

- The plugin name `session-awareness` and the section title "Sessions at a glance".
- `wh claim` / `wh done` as the two commands; they are core; events carry the full session UUID, attributed from
  `CLAUDE_CODE_SESSION_ID` (or the job dir for subagents and as a fallback).
- The hook is Node, passed through `--settings` like the bash-snapshot hook, fires on `UserPromptSubmit` always and on
  `PreToolUse` at most every 5 minutes.
- Nudges are change lines, not the full block; the full block only for a new sibling.
- Handoff and PR sessions start receiving `session-context` fragments (two small edits outside the plugin).
- The store gains `listEvents` and `boundWorktrees` for plugins rather than the plugin querying core tables itself.
- Failed sessions stay in the digest; done and stopped ones leave it. The explorer gets no digest.
- Default on; stale after 10 minutes.
