---
name: ticket-notes
description: Keep a per-ticket SilverBullet note (<notes dir>/tickets/<KEY>.md, shown at /notes/tickets/<KEY> on work-hub and as the workspace's Note tab) up to date with scripts the user needs to run, checklists of manual steps, and context to refer back to. Use in every ticket session when you write a script for the user to run, when they do or ask for a manual step, when a decision or gotcha is worth remembering, or when they say "make a note for me…", "@todo - …", "add this to the ticket note", "note this", "open the ticket note", or ask about SilverBullet or the notes server.
---

# Ticket notes

Each ticket has a markdown note at `<TW_NOTES_DIR>/tickets/<KEY>.md` (default `~/notes`). The user reads and edits it in SilverBullet, which work-hub serves at `/notes/tickets/<KEY>` on its own origin (`TW_NOTES_URL`, default `/notes`); it is also the workspace's Note tab in work-hub. It holds what code, git, and API state won't show: which scripts to run, which manual steps are done, and why things are the way they are. Print the configured values with `${CLAUDE_PLUGIN_ROOT}/scripts/config.sh`.

## Get the note

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/ensure-ticket-note.sh <KEY> [--title "<Jira summary>"] [--worktree <path>] [--path-only]
```

It creates the note from a skeleton if it's missing (frontmatter, then **Scripts**, **Manual steps** and **Context** sections) and prints its URL (a path on work-hub's origin), or its file path with `--path-only`. work-hub usually creates the note already when the workspace is made. Keys are always upper-case. Then edit the file directly with Read/Edit; SilverBullet picks up changes on disk.

## What to add, and when

Add as you go, not at the end, without being asked.

- **"make a note for me…"** (or "note that…", "remember that…"): add it under **Context**, in the user's words, tightened if rambly. If it's clearly a script or a manual step, put it in that section instead.
- **"@todo - …"**: add `- [ ] …` under **Manual steps**. Several `@todo` lines become several items.

Confirm in one line which section you added to. If the session has no ticket key, ask which ticket rather than guessing.

Keep entries short; add them under the right heading (in order, for manual steps); never rewrite or delete what the user wrote.

- **Scripts:** whenever you write a script for the user to run, add a `###` heading with the script name, one line on what it does, then each command to run on its own line in its own fenced code block, exactly as it would be typed in the terminal: one `!` line, starting at column 0, never inside a list item or inline in prose. Give the dry run and the `--apply` run separate blocks, each with a short label line above it. List scripts in the order they're run. Note when a script was run and the outcome once you know. For example:

  ````markdown
  ### seed-test-users.sh
  Creates 5 test accounts in staging. Ran 2026-10-15, ok.

  Dry run:
  ```
  ! /tmp/my-repo/ABC-1234/seed-test-users.sh
  ```
  Real run:
  ```
  ! /tmp/my-repo/ABC-1234/seed-test-users.sh --apply
  ```
  ````
- **Manual steps:** a `- [ ]` checkbox for each step done by hand or still to do: console clicks, config in a vendor dashboard, flags toggled, secrets rotated, someone pinged. Tick it (`- [x]`) when the user confirms it's done. When order matters, keep the list in the order the steps must happen (e.g. before merge → deploy → after deploy), inserting new steps where they belong rather than appending. If one item hides two ordered steps, split it. Make each one readable out of context, since tasks can roll up across tickets in SilverBullet.
- **Context:** decisions and why, gotchas, useful links (dashboards, Slack threads, docs), anything the user would want when they come back in a month.

Don't duplicate what Jira, the PR, or the code already say; link to them instead.

## The server

work-hub's notes plugin runs SilverBullet over the notes dir and serves it at `/notes` behind work-hub's sign-in; nothing per ticket starts it. If the Note tab or the URL doesn't load, tell the user the notes server is down and point them at the notes plugin's setup guide in work-hub (`plugins/notes/setup/SETUP.md`); don't install or restart it yourself.

Shell commands from notes (`shell.run`) are off (`SB_SHELL_BACKEND=off`). Don't turn them on without asking the user.

macOS volumes are usually case-insensitive, so never create two pages whose names differ only in case.
