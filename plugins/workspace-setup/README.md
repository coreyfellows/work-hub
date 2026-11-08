# workspace-setup

"New workspace": start work from a Jira ticket key or a free-text prompt. The plugin creates the workspace and starts an
**explorer**, a `claude --bg` session that picks the repos, creates and records worktrees, writes a plan, sets the
workspace active and waits for you.

## What it does

- **`POST /api/workspaces`** `{ ticket?, prompt? }` → `{ ok, workspace }` (400 `{ error }` for neither, or a ticket that
  doesn't look like `ABC-123`). Synchronous: the page navigates to the workspace it gets back.
  - The workspace is created by the core store (`origin` ticket/prompt, status `setting-up`, title = the ticket key or the
    prompt's first line, cut to 60 characters). A ticket gets a `jira` link to `<jiraBaseUrl>/browse/<KEY>`.
  - Its note (with the notes plugin on) comes from the core's `created` workspace event, not from here.
  - Then the explorer starts (`ctx.sessions.startBackground`, purpose `explorer`, model `explorerModel`, named
    "<title>: setup", cwd = the worktrees root: trusted, and not inside any one repo). It's recorded on the workspace
    with role `explorer`, and a `dispatched` event is logged.
- **The explorer prompt** (`explorerPrompt` in `dispatch.ts`, tested): setup and reconnaissance only. For a ticket, load
  `ticket-workflow:ticket-defaults` and run its "Starting work on a ticket" steps, then read the ticket and its epic.
  Work out the repos by reading code, create one worktree per repo the ticket-workflow way
  (`~/worktrees/<repo>/<KEY>`, branch `f-<KEY>-<desc>`, then `trust-worktree.sh`), reusing an existing one. Record
  everything with `wh` (`ctx.paths.whCommand`: worktree, title, epic, links), then `wh note` the plan, `wh status … active`,
  reply with the plan and wait. It's told NOT to start sessions itself, overriding ticket-workflow's
  one-session-per-worktree rule: work-hub owns those. Other plugins' `explorer` prompt fragments go at the end.
- **Resume after a restart** (`resumeDispatch`, at `ctx.onStart`): a workspace still `setting-up`, with no sessions,
  made in the last 15 minutes (`needsExplorer`, tested) gets its explorer now (`dispatch-resumed` event, or
  `dispatch-resume-failed` with the error).
- **`workspace-rules` prompt fragment**: every prompt work-hub writes for a workspace session (new, handoff, PR) ends
  with the core's generic rules (sibling sessions only as plain `claude --bg` jobs in a recorded worktree; record with
  `wh`). This plugin adds the ticket-workflow part (`ticketWorkflowRules`): new worktrees go in
  `<worktreesDir>/<repo>/<KEY or short-kebab-desc>` on a `f-<KEY>-<desc>` branch, then `trust-worktree.sh`; no
  `spawn-ticket-session`, cmux or terminal workspaces, or `EnterWorktree`.

## Web

- **`page`** `/workspaces/new` (no nav tab): the form (Ticket / Prompt, extra context, Start). The core router lets a
  static page path win over its own `/workspaces/:id` (`web/src/lib/staticRoute.ts`).
- **`workspace-list-action`** `new-workspace`: the "+ New workspace" link in the Workspaces page header.
- **`palette-commands`** (order 10): "New workspace" in the palette's command mode (`>`), which opens the form.
- `styles.css`: the form's `.form` column.

## Settings

Read with `ctx.config.get`: env `WORK_HUB_WORKSPACE_SETUP_<KEY>` first, then `plugins.json` `settings["workspace-setup"].<key>`.

| key | default | what |
| --- | --- | --- |
| `explorerModel` | `opus` (old env `WORK_HUB_EXPLORER_MODEL` still honoured) | the explorer's model: picking repos and base branches is judgment-heavy |
| `jiraBaseUrl` | empty: no Jira link (old env `TW_JIRA_BASE_URL` still honoured) | where a ticket workspace's Jira link points |

The worktrees root, the repos dir, the ticket-workflow scripts folder and the `wh` path are core paths (`ctx.paths`).
The scripts folder is the ticket-workflow plugin's bundled `scripts/` while that plugin is on (read on use); with it off
and `WORK_HUB_TW_SCRIPTS` unset it's empty, and both the explorer prompt and the `workspace-rules` fragment name the core's
`<repoRoot>/bin/wh trust <path>` (same effect: `ctx.sessions.trustWorktree`) instead of `trust-worktree.sh`.

## Caveats

- `POST /api/workspaces` starts a real Claude session: don't call it to test; the prompt and the resume rule are unit-tested.
- With the plugin off there is no way to create a workspace from the UI (PR sessions and reviews still create their own).
