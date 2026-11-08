# notes

A SilverBullet note per workspace (scripts to run, manual steps, context), made when the workspace is created and
embedded in the workspace page as its **Note** tab. Off by default: it needs a SilverBullet server, on loopback or behind
work-hub's own origin (see Setup).

## What it does

- **Note per workspace**: ticket workspaces use the ticket-workflow plugin's `ensure-ticket-note.sh`
  (`<notesDir>/tickets/<KEY>.md`, called with `--path-only`, `--title` and `--worktree` when known); every other workspace
  gets the same skeleton (frontmatter, title, the original request quoted, Scripts / Manual steps / Context headings) at
  `<notesDir>/workspaces/<id>.md`. An existing note is never overwritten.
- **Made on creation**: the plugin listens for the core's `workspace-event` with `type: 'created'` (emitted by
  `createWorkspace`) and makes the note on the next tick, so worktrees the creator records right away are named in it.
  Workspaces of origin `pr` or `review` that have no worktree yet wait for their first `worktree` event (a PR session
  records its worktree once Claude has started), up to 2 minutes, then the note is made anyway (unless the workspace is
  done by then: its session never started). Success logs a `note` workspace event (the page), failure `note-failed`
  (the message); neither blocks the work. The core doesn't call the plugin: with it off, workspaces are made without notes.
  Workspaces created by `wh` (another process) don't emit the event; the Note tab's "Create note" covers those.
- **Session context**: a `session-context` prompt fragment adds `- Its note (scripts, manual steps, context): <path>`
  to what new and review sessions in the workspace are told, once the note exists.
- **Service** `notes` (`ctx.services.get('notes')`, only while this plugin is on): `{ notePath(ws), noteInfo(ws), ensureNote(ws) }`.

## Routes

- `GET /api/plugins/notes/workspaces/:id` → `NoteInfo` `{ page, path, url, exists }` (404 for an unknown workspace).
  Was the `note` half of the core's old `GET /api/workspaces/:id/tools`.
- `POST /api/workspaces/:id/note` → creates the note if it's missing and answers the same `NoteInfo` (500 with
  `{ error }` if the script fails).

## Slots

- `workspace-panel` `note` ("Note", `wide`, order 101: after Diff, before Code): the note's page name, "Open ↗" and
  the note in an iframe (`url`); with no note yet, a "Create note" button. It loads its route once, when the tab is
  first opened (panels stay mounted after that), so nothing polls; Low data needs nothing more. The `.tool-*` classes
  it uses are the core's (shared with Diff and Code).

## Settings

Read with `ctx.config.get`: env `WORK_HUB_NOTES_<KEY>` first, then `plugins.json` `settings.notes.<key>`.

| key | env | default | what |
| --- | --- | --- | --- |
| `url` | `WORK_HUB_NOTES_URL` | `/notes` | where SilverBullet is served (behind LAN access; `http://127.0.0.1:<port>/notes` on localhost) |
| `notesDir` | `WORK_HUB_NOTES_NOTES_DIR` | `$TW_NOTES_DIR`, else `~/notes` | SilverBullet's pages folder |

`ensure-ticket-note.sh` comes from the ticket-workflow plugin's bundled scripts (`ctx.paths.ticketWorkflowScripts`;
`WORK_HUB_TW_SCRIPTS` while that plugin is off). With neither, ticket notes get the same skeleton written by this plugin.

Read only by the setup scripts (`setup/install-agent.sh`, `scripts/setup-lan.sh`), not the plugin: `localPort` (18744) and `silverbullet` (the binary).

## Setup

Follow `setup/SETUP.md` (written for an agent to follow end to end). SilverBullet runs as its own server: pages in
`notesDir`, `SB_URL_PREFIX=/notes`, no SilverBullet login, bound to 127.0.0.1, kept running by a launchd agent from
`setup/install-agent.sh` (dry run by default, `--apply`, `--uninstall`).

- **Localhost only** (the default): set `url` to `http://127.0.0.1:<port>/notes` and the Note tab frames it directly.
- **LAN access** (the `auth` plugin plus `scripts/setup-lan.sh`): leave `url` at `/notes`. The front proxy sends
  `/notes*` to SilverBullet only after `forward_auth` to work-hub's `/auth-check` (signed in, else a redirect to
  `/login`). Same origin means anything running in the note page (SilverBullet scripts) can call work-hub's API as you.
