# adversarial-review

"Adversarial review" buttons on each worktree in a workspace's Details and on the PR page review the branch **in the
background**, then start **one** session to address the findings. Requires `worktree-diff`; the PR side needs the `github`
plugin.

## What happens

- Both buttons start a `review` job in the header tray (icon ⚔). Its detail shows "N of M reviewers finished", and its
  link opens the new session. One review per worktree runs at a time.
- **Restarts**: reviews survive a server restart. `ReviewState` is the job payload, and the plugin registers a resumer for
  the `review` kind:
  - reviewers that already finished are kept; the rest rerun from scratch;
  - the session id is saved the moment the session starts, so it can't be started twice;
  - a PR review whose workspace wasn't settled yet redoes that part.

  The reviewer processes of the old server are orphaned, not killed, and finish unused.
- **PR reviews**: the PR route finds or creates the branch's worktree (`ensureBranchWorktree` from the github plugin's
  `github` service, shared with PR sessions). It reviews in the workspace that links the PR or owns the worktree, else in
  a new "review" workspace. Fork PRs are refused.
- **Reviewers** are headless `claude -p` runs with read-only tools, owned by the server job, never sessions. They run inside
  the worktree, so they are named `wh-review:<id>` (`REVIEWER_RUN_PREFIX`) and hidden with `ctx.sessions.hide`. Without
  that, reconcile would adopt them into the workspace as `main` sessions (it did, once). Don't run anything headless in a
  recorded worktree without hiding it the same way.
- **Diff reviewed**: `git diff <base>...HEAD`, where the base is the recorded one or the PR's, fetched first. Uncommitted
  changes count.
- **Repo guidance**: `reviewGuidance.ts` (tested) looks for `REVIEW.md`, `REVIEWING.md`, `.claude/review.md`,
  `docs/REVIEW.md` or `.github/REVIEW.md`, else a "Code review"-style heading in `CLAUDE.md`/`AGENTS.md`. If the repo has
  any, ONE reviewer (the `model` setting) follows it. Otherwise every configured reviewer runs in parallel, each covering
  correctness, security, tests/edge cases and design.
- **Reviewers are pluggable** through the reviewers file (the `reviewersFile` setting). It looks like
  `{"reviewers": [{"id", "label"?, "model"} | {"id", "label"?, "command": [argv…]}, "timeoutMs"?, "enabled"?]}`:
  - with no file, the reviewers are Claude fable, opus and sonnet; a broken file fails the job loudly;
  - a `model` entry is a read-only `claude -p` that fetches the diff itself;
  - a `command` entry gets the prompt plus the diff (400 KB cap) on stdin and prints its findings on stdout.

  Parsing and prompts are in `reviewers.ts` (tested).
- **Report and session**: when the reviewers finish, their findings go into one report, `<dir>/<ws>-<branch>-<time>.md`.
  The plugin adds that folder to the file viewer with `ctx.files.addRoot`, so the path opens in a modal. A root added that way
  should be a folder the plugin owns (normally `ctx.paths.pluginState`); the default `<stateDir>/reviews` is kept for existing
  reports, and `dir` should never be set to something broad like the home or state dir: every session could then open files there. Then one session
  ("Address review: <branch>", `main` role, the `model` setting) starts in the worktree, with
  `ctx.prompts.workspaceContext` (what the workspace is about, and its rules) ahead of `addressTask` (tested). That task
  tells it to:
  1. merge duplicates and verify each finding;
  2. work out a change for those that hold, WITHOUT editing;
  3. ask via AskUserQuestion: one question per finding, recommended first, "Do nothing" to skip;
  4. only then make exactly the approved changes. It never pushes or touches the PR.

  If some reviewers fail, the report says so. If all fail, the job fails and no session starts.

## Routes

| route | body | answer |
| --- | --- | --- |
| `POST /api/workspaces/:id/reviews` | `{ path, prUrl? }` (`path`: one of the workspace's worktrees) | `202 { ok, jobId }`; 404 no such workspace; 400 not one of its worktrees |
| `POST /api/prs/review` | `{ owner, repo, number }` | `202 { ok, jobId }`; 400 bad PR reference; 503 when the github plugin is off (looked up per request) |

## Slots

- `worktree-action` `review`: the "Adversarial review" link on each worktree (default order, after github's PR link at 50).
  It passes the branch's PR URL, if the github source lists one.
- `pr-action` `review`: the button on the PR page (`ReviewButton.tsx`).
- `job-kind` `review`: ⚔.

## Settings

`ctx.config.get`: env `WORK_HUB_ADVERSARIAL_REVIEW_<KEY>` or plugins.json `settings["adversarial-review"].<key>`. The old env
names still work as the defaults.

| key | default | old env |
| --- | --- | --- |
| `model` | `opus` | `WORK_HUB_REVIEW_MODEL` |
| `dir` | `<stateDir>/reviews` | `WORK_HUB_REVIEW_DIR` |
| `reviewersFile` | `<configDir>/reviewers.json` | `WORK_HUB_REVIEWERS_FILE` |
