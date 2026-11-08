---
name: ticket-defaults
description: The user's Jira defaults. For new tickets, assign to them and put in their board's active sprint. When a ticket session starts, move the ticket to In Progress and fill in missing priority, story points, and sprint (asking the user about priority and points). Load before creating any Jira ticket, and at the start of every ticket session.
---

# Jira ticket defaults

Apply these unless the user says otherwise. They override defaults in other ticket skills.

First read the user's settings: `${CLAUDE_PLUGIN_ROOT}/scripts/config.sh`. The `TW_JIRA_*` values below come from there. Use whichever Jira tools this session has (for example an Atlassian MCP server). If a setting is empty, skip the step that needs it and tell the user once which setting to fill in (in the config file the script prints).

## Assignee and sprint

- **Assignee:** accountId `TW_JIRA_ACCOUNT_ID`. Pass the accountId, never the literal `"currentUser"`.
- **Sprint:** the *active* sprint on board `TW_JIRA_BOARD_ID` (sprint names start with `TW_JIRA_SPRINT_PREFIX`, if set). Look it up fresh each time, because sprint IDs change every sprint:
  - Search with JQL `project = <TW_JIRA_PROJECT> AND sprint in openSprints() AND assignee = "<TW_JIRA_ACCOUNT_ID>"`, requesting the sprint field (`TW_JIRA_SPRINT_FIELD`, usually `customfield_10020`).
  - Take the sprint with `state: "active"` and that `boardId`, and pass its numeric `id` as a bare integer in that field.
  - If you can't find an active sprint, create the ticket without a sprint and tell the user.
- When you report the ticket, state the assignee and sprint name. If the sprint ends within a day or two, say so, so they can move the ticket to the next sprint.

## Starting work on a ticket

Run this at the start of every ticket session (any session whose prompt names a Jira key to work on, such as a work-hub workspace session for a ticket), before writing code. Fetch the ticket first, requesting summary, description, issue type, status, priority, the points field (`TW_JIRA_POINTS_FIELD`) and the sprint field. Only fill in what's missing; never overwrite a value that's already set.

1. **Status:** if it isn't already `In Progress`, move it there with transition `TW_JIRA_IN_PROGRESS_TRANSITION`. If that's empty or isn't offered, look up the ticket's transitions and pick the one named "In Progress".
2. **Priority:** treat null, or the project's "no priority" value (`TW_JIRA_NO_PRIORITY`, e.g. `TBD`), as missing. Get the allowed values from the ticket's edit metadata.
3. **Story points** (`TW_JIRA_POINTS_FIELD`, a number): missing when null. Use Fibonacci values: 1, 2, 3, 5, 8, 13. If the field isn't configured, find it in the edit metadata (a field named "Story Points" or "Story point estimate").
4. **Sprint:** if the ticket has no open sprint, add it to the active sprint (same lookup as above). Leave it alone if it's already in any open sprint. If the active sprint ends within a day or two, say so.

**Ask about priority and points; don't set them silently.** Read the ticket's summary and description, then ask both in one `AskUserQuestion` call (one question each, skipping any that's already set): your recommendation first, marked "(Recommended)", one or two alternatives, plus "Do nothing" (leave it unset). Put a one-line reason for the recommendation in the question text. Calibrate:

- **Points:** 2 for a tiny, mechanical change (config, catalog entry); 3 for a typical well-scoped bug fix or task; 5 for multi-part work, a new scaffold, cross-repo changes, or a spike; 8–13 only for large, multi-sprint stories.
- **Priority:** normal by default; one step up when it blocks other work, has a deadline, or affects users or prod; the top two only for prod outages or release blockers; one step down for cosmetic or nice-to-have work.

Do the status and sprint updates without asking, then apply the user's answers. Report what changed in one short line (e.g. "ABC-1234: In Progress, Normal, 3 pts, Sprint 42"). If a Jira call fails, say so and carry on with the ticket work.
