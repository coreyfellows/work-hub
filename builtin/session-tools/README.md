# session-tools

Managing a workspace's Claude sessions by hand: **Hand off** a session to a fresh one with a brief, **Close** one, and start
a **New session** whose model and name are picked by difficulty when left on auto. On by default.

## Hand off (fresh session with a brief)

"Hand off" in a workspace session's header `⋯` menu (`handoff.ts`, `POST /api/workspaces/:id/sessions/:sid/handoff`): a
headless fork (`claude -p --resume <id> --fork-session --no-session-persistence --tools ''`, run in the session's cwd, same
model) writes a handoff brief with the full context; it's saved under `handoffDir` (default `<stateDir>/handoffs/`); a new
`claude --bg` session starts in the same cwd with the chosen model (below), role and name, told to restate and wait; then the
old session is stopped (only after the new one is recorded, so a failure loses nothing). Logged as a `handoff` event.

It runs as a `handoff` job (header tray) and survives a server restart: `HandoffState` (stage `brief` → `start` → `stop`, plus
the brief path, old model and new session) is saved with the job after every step, and `handOff` resumes from the saved stage
(`brief` redoes the brief from scratch; `start` reads the saved brief file and starts the session; `stop` records the new
session and stops the old one). The new session is saved the moment it starts, so a restart can't start a second. A restart
during `brief` orphans the headless fork, which finishes unused. The resumer is registered in `register()`, i.e. before the
core reopens the jobs store at startup.

- Optional `note` in the body: instructions the new session follows after restating (without one it waits).
- Optional `model`: `auto` (the form's default; `planSession` rates the note, else the brief, and picks, with the reason shown
  in the job's detail), `same` (the model the old session last answered with; `sessionModel` if unknown) or
  fable/opus/sonnet/haiku (`SESSION_MODELS` from plugin-api). Anything else is a 400.

## Close

**Close** (`⋯` menu) posts to the core's `POST /api/workspaces/:id/sessions/:sid/close` (the same route as the core's ✕ on a
session tab), which stops the session (`claude stop` or SIGTERM); its record stays (`claude attach` / `claude --resume` still
reopen it), logged as `session-closed`. A toast says so; no confirm (it's reversible). The route is core, not this plugin's.

## New session

**+ New session** (first entry of the workspace tab strip's `+` menu; a modal with prompt, folder, model and name;
`POST /api/workspaces/:id/sessions/new`, body `{ prompt, cwd?, model?, name? }`) starts a `claude --bg` session in one of the
workspace's worktrees (or the worktrees root when `cwd` is empty; anything else fails the job: `sessionDirs` from plugin-api),
model auto/fable/opus/sonnet/haiku. It answers `202 { jobId }` (a `new-session` job) once the prompt is non-empty.

With model "auto" (the form's default) or no name, `sessionPlan.ts` asks a headless no-tools `claude -p` (`plannerModel`,
haiku; ~10s) to rate the task's difficulty and pick the model per the ticket-workflow policy (haiku trivial, sonnet
well-scoped, opus complex/ambiguous, fable hardest long-horizon) and a 3–6 word name; a model or name you give is kept. On
failure it falls back to `sessionModel` (opus) and a name cut from the prompt. The pick and its reason go in the job's detail
and the `session-started` event. The prompt is the core's workspace context (`ctx.prompts.workspaceContext`: ticket, epic,
original request, plan, worktrees, links, the `session-context` fragments, the last 5 sessions' transcript paths, the
workspace rules) followed by your task. Logged as `session-started`.

## Routes

| route | what |
| --- | --- |
| `POST /api/workspaces/:id/sessions/:sid/handoff` | `{ note?, model? }` → `202 { jobId }`; 404 `unknown workspace or session`, 400 `unknown model: …` |
| `POST /api/workspaces/:id/sessions/new` | `{ prompt, cwd?, model?, name? }` → `202 { jobId }`; 404 `no such workspace`, 400 `a prompt is required` |

## Slots

- `session-action`: "Hand off" (opens the hand-off modal, its `dialog`) and "Close session", after the core's "Intent"; only
  when the session view has a `workspaceId` (embedded in a workspace page).
- `workspace-tab-kind` `new-session` (order 10, no tabs): its `menu` puts "New session" first in the `+` menu, before the
  terminals plugin's entries (a `tabstrip-action` would come after "Add running session"); its `after` draws the modal.
- `palette-commands` (order 20): "New session in this workspace" in the palette's command mode (`>`), on a workspace's page
  or one of its sessions' pages. It goes to the workspace page and opens the same new session modal as the `+` menu
  (whose own "New session" entry is marked `palette: false`, so it isn't listed twice).
- `job-kind`: `handoff` ⇄, `new-session` ＋.

## Settings

`ctx.config.get` → env `WORK_HUB_SESSION_TOOLS_<KEY>` or plugins.json `settings["session-tools"].<key>`; the old env names
still work as the defaults.

| key | default | old env |
| --- | --- | --- |
| `sessionModel` | `opus` | `WORK_HUB_SESSION_MODEL` |
| `plannerModel` | `haiku` | `WORK_HUB_PLANNER_MODEL` |
| `plannerTimeoutMs` | `60000` | `WORK_HUB_PLANNER_TIMEOUT_MS` |
| `handoffDir` | `<stateDir>/handoffs` | `WORK_HUB_HANDOFF_DIR` |
| `summaryTimeoutMs` | `300000` (the brief's headless fork) | `WORK_HUB_HANDOFF_TIMEOUT_MS` |

## Caveats

- With the plugin off, the core's ✕ on a session tab still closes the session (the close route is core); the "model auto
  picked" detail and the jobs tray are core and unaffected.
- The prompts are locked by `prompts.test.ts` (handoff and planner prompts, byte-identical to the pre-plugin core except
  the app's old name → "work-hub"); the workspace context header stays core (`server/workspaceSessions.test.ts`).
