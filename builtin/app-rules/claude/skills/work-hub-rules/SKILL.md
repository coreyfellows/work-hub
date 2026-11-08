---
name: work-hub-rules
description: Rules for sessions driven from work-hub: how to hand the user runnable ! commands and scripts, ask follow-up questions with AskUserQuestion, and record manual steps in the workspace note. Use when giving the user a command to run, a script, or a follow-up question.
---

# work-hub rules

work-hub shows your messages to the user and builds features on their shape, so follow these.

Commands and scripts for the user to run
- To give the user a command to run, put it in a fenced code block that is exactly one line, starting at column 0 with `!` (e.g. `! ~/.local/state/work-hub/plugins/app-rules/scripts/<repo>/<worktree>/do-thing.sh --apply`). Only that shape gets a Run button. Never indent it, even inside a list, and never split it over several lines.
- Anything longer than one simple command (pipes, loops, several flags, env setup) goes in an executable script at `~/.local/state/work-hub/plugins/app-rules/scripts/<repo>/<worktree>/<descriptive-name>.sh` (work-hub's own storage, not `/tmp`; create the folder), written for the user without being asked. Give them the one-line `!` command to run it.
- Scripts start with `set -euo pipefail` and are fully non-interactive, because they run from a `!` line with no terminal: no `read` prompts, no `[y/N]`, no `/dev/tty`, no secrets on stdin. Take every input as a flag or environment variable and fail with a message naming the missing one.
- Anything that changes something outward-facing is a dry run by default, with an explicit `--apply` for the real run. Where the real run needs confirmation, take a flag that names what changes (e.g. `--confirm staging,prod`) instead of prompting.
- Never print secrets: command output is stored and shown. Get a secret from the secret store (e.g. Vault) or generate it in the script.

Follow-up questions
- Ask follow-ups (a next step, an open decision, an offer, a question for the user) with the `AskUserQuestion` tool so the user can answer inline. One question per follow-up, up to 4 per call, a short header.
- Whenever a question has a small set of plausible answers (which approach, which file, yes/no, pick one or several), offer them as 2-3 concrete options, each with a short description of what it will do, instead of asking in prose; use `multiSelect` when several can apply. Do this for mid-task decisions too, not only at the end. Truly open-ended questions still go through the tool, with your best guesses as options.
- Put the recommended option first and end its label with "(Recommended)". Always include a "Do nothing" option (leave it as is, take no further action). Do not add an "Other" or "Describe what to do" option: the tool already lets the user type their own answer.
- Write the normal summary first; the question replaces only the "next step" sentence. If the user picks "Do nothing", stop and do not re-offer it.

Notes
- If the workspace has a note, add each `!` line you hand the user, and any manual step they need to take, to it (manual steps as checkboxes). When they say "make a note for me" or "@todo", add that too.
