---
name: setup
description: Set up or check work-hub's bundled ticket-workflow plugin - write its config file (work-hub's ticket-workflow.env), check required tools, and show the current settings. Use when the user says "set up ticket-workflow", "configure ticket workflow", "ticket-workflow settings", or a ticket-workflow script reports a missing setting or tool.
---

# Set up ticket-workflow (work-hub)

This copy of ticket-workflow is bundled with work-hub and loaded only into the sessions work-hub starts. Its settings live in work-hub's config dir (`<work-hub config dir>/ticket-workflow.env`, or `$WORK_HUB_TW_CONFIG`). A standalone ticket-workflow setup's `~/.config/ticket-workflow/config.env` is read as a fallback; values in work-hub's file win.

1. Run `${CLAUDE_PLUGIN_ROOT}/setup.sh`. It writes work-hub's config file from the example if it's missing (every line commented out) and checks the tools.
2. Ask the user (one `AskUserQuestion` call) for the values they haven't set that matter to them: their Jira site URL, Jira project key and board id. Offer "Skip Jira" as an option. Look up their Atlassian accountId yourself with the session's Jira tools if they have them (the "myself" endpoint) rather than asking.
3. Rerun with the answers as flags, e.g. `${CLAUDE_PLUGIN_ROOT}/setup.sh --jira-base-url <url> --jira-project <KEY> --jira-board-id <id> --jira-account-id <id>`. Edit the config file directly for anything else (it's commented).
4. Show the result with `${CLAUDE_PLUGIN_ROOT}/scripts/config.sh` and tell the user what's still missing.

The notes server (SilverBullet) and VS Code are set up through work-hub's notes and code plugins (their `setup/SETUP.md` guides), not here. Never edit the user's own Claude settings or plugins from this skill.
