---
name: scrutinize-pr
description: Start a work-hub PR summary (the PR page's Summary tab, a narrative guide to the change written in the background). Use when the user runs /work-hub:scrutinize-pr, optionally with a PR number, owner/repo#number or PR URL, or asks to "summarize this PR in work-hub" or "scrutinize the PR".
argument-hint: "[PR number | owner/repo#n | PR URL]"
---

# Start a PR summary in work-hub

work-hub writes the summary in the background (a job in its tray, a few minutes) and shows it in the PR page's
**Summary** tab, where the user can select passages and ask about them. This skill only picks the PR and starts it;
don't summarize the PR yourself.

The helper is `node ${CLAUDE_PLUGIN_ROOT}/skills/scrutinize-pr/scrutinize-pr.ts`.

## 1. Pick the PR

The argument, if any: `$ARGUMENTS`

- **An argument was given** (a number, `#123`, `owner/repo#123` or a PR URL): use it as is. A bare number means a PR in
  this folder's repo.
- **No argument**: find the most appropriate PR for this session.
  1. Run `node ${CLAUDE_PLUGIN_ROOT}/skills/scrutinize-pr/scrutinize-pr.ts candidates`. It prints JSON: this folder's repo and branch,
     the work-hub workspace this session belongs to, and `candidates` (PRs with `why`: this folder's branch, linked to the
     workspace, a workspace worktree's branch).
  2. Also count what this conversation shows: a PR you opened, pushed to or were asked about here.
  3. Use one PR without asking only when it is clearly the one: a single candidate, or the PR for this folder's branch
     when nothing else competes, or the PR this conversation has been about. Prefer open PRs over merged or closed ones.
  4. **When in doubt, ask** with `AskUserQuestion` (header "PR"): up to three likely PRs as options, the best first marked
     "(Recommended)", each labelled `repo#number` with its title and why it is a candidate in the description, plus
     "Do nothing". The user can type another PR. If there are no candidates at all, ask for the PR (number, URL or
     `owner/repo#n`) the same way, with "Do nothing" as an option. If they pick "Do nothing", stop.

## 2. Start it

Run `node ${CLAUDE_PLUGIN_ROOT}/skills/scrutinize-pr/scrutinize-pr.ts start <the PR>`. It hands the request to work-hub and prints
its answer as JSON:

- `status: "started"` (or `"running"`: one was already being written): tell the user it's being written, that it takes
  a few minutes, and give the `url` (the Summary tab) as a link, plus where the file will be (`path`).
- `status: "failed"`: say why (`error`), e.g. the github plugin is off, or the PR is on another GitHub host than work-hub
  uses.
- An error from the script itself (work-hub isn't running, or the plugin is off): pass it on as it is.

Only if the user asked to wait for it or to use the summary in this conversation, add `--wait`: it returns once the
summary is written (`status: "done"`, with `path`), up to 30 minutes. Then you may read the file at `path`.
