# Ticket workflow (work-hub's bundled ticket-workflow plugin)

This session was started by work-hub, which loads its ticket-workflow plugin into the sessions it starts. These are the user's standing conventions for ticket work and worktrees. Scripts referenced below live in `@PLUGIN_ROOT@/scripts`, and the settings are in `@CONFIG_FILE@` (print the effective values with `@PLUGIN_ROOT@/scripts/config.sh`).

## work-hub owns sessions

work-hub starts, names, records and stops the Claude sessions for a workspace. Follow the session and worktree rules in this session's prompt; where they differ from anything else you've been told about starting sessions, they win. Don't open terminal multiplexer workspaces or editor windows for the user: work-hub shows the session, the ticket note and the code itself.

## Model choice

When you pick a model for a session or a subagent (or are asked which one fits), tell the user the choice with a one-line reason: `haiku` for trivial, mechanical work (typos, version bumps, one-line config); `sonnet` for well-scoped work with an obvious approach; `opus` for complex or ambiguous work (multi-file or cross-service changes, unknown root causes, security-sensitive code, vague requirements); `fable` only for the hardest, longest-horizon work where `opus` is likely to struggle. When unsure, go one tier up. If the user names a model, use it.

## Jira tickets

When a session starts work on a Jira ticket, before any code, load `ticket-workflow:ticket-defaults` and follow its "Starting work on a ticket" section. Load the same skill before creating any Jira ticket.

## Worktrees

Every worktree lives at `<worktrees root>/<repo-name>/<TICKET>` (the root is `TW_WORKTREES_ROOT`, default `~/worktrees`). With no ticket, the folder is a brief 3–4 word kebab-case description instead. Name the branch `f-<TICKET>-<short-desc>` when there's a ticket, else the short description. After creating one with `git worktree add`, run `@PLUGIN_ROOT@/scripts/trust-worktree.sh <path>` so Claude sessions can start in it, and record it in work-hub as this session's prompt says.

## Ticket notes

In a ticket session, keep the ticket's note up to date with the `ticket-workflow:ticket-notes` skill: every script the user needs to run (as a `!` line), manual steps as checkboxes, and context worth keeping. When the user says "make a note for me…" or "@todo - …", add it to that note.
