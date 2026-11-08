# command-runs (a conversation-view feature)

Commands Claude hands you to run yourself, and the ones you ran. Claude Code's bash mode (`! <command>` at its prompt) runs
a command in the session's own shell and records the command and its output in the conversation; in a background job
that also starts a turn, so Claude reads the output without a follow-up message (verified 2026-11-03).

Part of conversation-view (always on with it). Server and web halves.

## What it does

- **Command cards.** In Chat, a fenced code block that is exactly one line, starting at column 0 with `!`, becomes a
  card with Run, Copy, View script, View output and, on a workspace page, ▶ Terminal (`bangCommand` in `CommandCard.tsx`).
  Inline code, multi-line or indented blocks stay plain code. The raw Log draws every such block as plain code
  (`LogViewContext.readable` is false there). Cards only appear in Claude's messages. Question forms deliberately get
  no Run (the owner's call).
- **Run** (`POST /api/sessions/:id/run`, `runCommand.ts`):
  - If Claude is idle with no open question, it types `!`, then the command, then Enter.
  - Otherwise the command is queued, and a poller types it once the session has been idle for two checks in a row
    (3s apart). A run queued for over 2h is marked "expired".
  - `cancel: true` drops a queued run. Interactive sessions get a 409.
  - "Idle" means `claude agents`' own idle (`Session.promptState`), not the job state. A turn that ends by asking you
    something leaves the job "blocked" while it sits at its prompt. "waiting" (a menu is up) never gets keys.
- **Durable record.** Every Run is a row in the core's `command_runs` table (core migrations 4-6; this plugin has no
  migrations of its own). A row moves from queued to ran, failed, cancelled or expired, and records the session,
  workspace and times.
  - The queue survives leaving the page and server restarts: `resumeQueues` runs at `onStart`.
  - What ran is kept for good. A ran row in a workspace also logs a `command-ran` workspace event.
  - Once a typed-in run's output lands in the transcript, `captureOutput` (waits up to 1h, resumed at startup) saves it
    on the row: `output`, `output_at`, `stderr`. Lists carry only `outputLines`.
  - The terminals plugin writes the `via = 'terminal'` rows (see its README).
- **Cards read the runs** through `GET /api/sessions/:id/run`:
  - `useCommandRuns` lives in the `shell` log-card's `Wrap`, so it's mounted for the whole conversation.
  - It re-fetches when the history grows, and every 3s while a run is queued or still running in a terminal.
  - Cards merge that list with the transcript's own runs for "Ran 5m ago".
- **"You ran" cards.** The transcript's `<bash-input>` / `<bash-stdout>` / `<bash-stderr>` user turns become one
  user entry with `shell: { command, output?, stderr? }` (the `shell` transcript enricher, `shell.ts`).
  - Entries carry up to 6KB of the output. The enricher keeps up to 512KB per run in its state.
  - It's drawn as a `ShellCard`, showing the last 12 lines until expanded. In Chat its group is labelled
    "You ran · <time>"; in the Log it's the whole `!` row.
- **Output viewer.** "View output" (on a Run card) and "Open" (on a "You ran" card, which also covers commands pasted by
  hand) open the full output in the shared `Modal`.
  - It shows line numbers and `highlightOutput`: JSON if it parses, a diff if it looks like one, otherwise a confident
    highlight.js guess among yaml/xml/ini/bash/sql, else plain text.
  - The data comes from `GET /api/sessions/:id/run/:runId/output` or `GET /api/sessions/:id/shell-output?i=<entry>`.
- **View script.** When a command names a path-like file (`commandCandidates` in `shared/scriptPath.ts`, used by both
  halves), `GET /api/sessions/:id/script?command=` reads the first one that is a regular text file of at most 512KB.
  - Allowed places: `/tmp`, the session's folder, `~/worktrees` or `~/repos`, checked after resolving symlinks.
  - The card shows its source with line numbers and highlight.js.
- **▶ Terminal.** On a workspace page, the card reads `TerminalRunContext`, a core-owned context in `plugin-api/web.ts`
  that the terminals plugin's tab kind provides. It opens a workspace terminal running the command. Without the
  terminals plugin, or outside a workspace, there's no button.

## Routes

| route | what |
| --- | --- |
| `POST /api/sessions/:id/run` `{ command, cancel? }` | run now or queue; answers `{ ok, status?, runs }` |
| `GET /api/sessions/:id/run` | `{ runs }`: the latest run of each command (ETag-revalidated) |
| `GET /api/sessions/:id/run/:runId/output` | one run with its recorded `output` |
| `GET /api/sessions/:id/shell-output?i=<entry>` | a transcript `!` run's full output by entry index |
| `GET /api/sessions/:id/script?command=` | the script file a command runs (`path`, `content`, `bytes`, `mtime`) |

## Slots

- `log-card` `shell` (order 30, after edit cards at 10 and git cards at 20), with `label: 'You ran'` and a `Wrap` that
  provides `CommandRunsContext` and `ShellRunsContext` to the whole conversation.
- `markdown-override` `pre`: a bang-command block becomes a `CommandCard`, in Chat only.

## Server hooks used

`ctx.transcript.addEnricher` (`shell`), `ctx.revalidate`, `ctx.db.raw` (+ an empty `ctx.db.migrate`),
`ctx.store.logEvent`, `ctx.sessions.typeSequence` / `KEY_BYTES` / `openQuestion` / `transcriptState`, `ctx.onStart`.

## Settings

None.

## Caveats

- The command check (one line, at most 2000 chars, no control characters) is the core's `invalidCommand` from
  plugin-api/server.ts, shared with the terminals plugin's "▶ Terminal".
- Low data: nothing here streams. The runs list polls only while something is queued or running.
