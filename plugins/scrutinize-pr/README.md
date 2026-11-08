# scrutinize-pr

A **Summary** tab on the PR page (`/prs/:owner/:repo/:number#summary`). On demand, Claude writes a guide to the PR: the
story of the change in the order that makes it easiest to understand, with code snippets, `inline code` and links to
the files at the PR's head, and the uninteresting boilerplate (minor CSS, config, renames, lockfiles…) at the bottom
under **Minutiae**. The guide is a Markdown file on this machine; the tab says how old it is and how much the PR has
changed since. Select any passage to ask about it: Claude answers in a thread under that section, or, when the answer
belongs in the guide, adds an addendum to the section or rewrites it. Requires the `github` plugin.

## What happens

- **Writing** ("Summarize this PR", later "Regenerate", which asks first): a `scrutinize` job (🔎 in the jobs tray; it
  survives a restart through its resumer) reads the PR through the github plugin's `github` service (`prDetail`,
  `prFiles`) and runs one headless `claude -p` with the `model` setting. Two ways it sees the code:
  - **With a clone** at `<repos dir>/<repo>` whose `origin` is this repo: it fetches the base branch and
    `refs/pull/<n>/head` (forks too), finds the merge base, and runs there with **only** read-only git allowed
    (`--tools Bash`, `--allowedTools` `git diff/show/log/grep/ls-tree/blame/cat-file`), told to read everything at the
    PR's head commit (`git show <head>:<path>`, `git grep <pattern> <head>`). File tools are off on purpose: the clone's
    working tree is some other branch, so reading files from disk would describe the wrong code. Nothing in the clone is
    changed besides the fetch.
  - **Without one** (or when the commits can't be fetched): the diff from GitHub goes in the prompt (capped at 400 KB),
    with no tools; the tab says "from the diff alone".

  The outline is fixed (`prompts.ts`): title and a one-line gist, Overview, How it works (one `###` per step, in
  reading order), Behaviour changes and risks, Tests, Minutiae. File references are links to the blob at the head commit.
  Regenerating keeps the old version, addenda included, in `history/`, and keeps the threads (re-anchored to the new
  sections by title; any whose section is gone are listed at the bottom as "Questions about an earlier version").
- **Update** (shown once the PR's head has moved; primary when its diff changed): a `scrutinize-update` job (🔁,
  resumable) that brings the guide up to date without rewriting it. It works out which files' part of the diff changed
  (the same snapshot comparison as "changed since"), then one headless run (`updatePrompt`) gets the guide with its
  section ids, those files, and the old and new heads: with a clone, `git log old..new` and per-file
  `git diff old new` (or each head's own diff when the branch was rebased); without one, or when the old head is gone,
  the current diff of just those files. It answers with section edits (`parseUpdate`): `replace` a section's body,
  `insert` a new section after one, `remove` one; sections it doesn't list stay exactly as they are, addenda included
  (`applyEdits` in `doc.ts`; edits naming unknown sections are skipped and reported in the job). Each update adds a line
  to a `## Updates` section (made before Minutiae): the date, old → new head, and what the commits changed. If the PR's
  diff is the same (a rebase with no real change), the head just moves, without a model run. The previous version goes
  to `history/`; threads are re-anchored like after a regeneration. The tab shows "updated … ago" beside "Written".
  Update and Regenerate never run at once for a PR.
- **Changed since**: when the tab opens (and whenever the page's poll sees a new head), it sends the PR's current head.
  If that differs from the head the guide was written at, the server compares the PR's files now with the snapshot it
  took when writing: per file, a hash of every `+`/`-` line of its patch (`since.ts`). So it reports files changed, new
  and no longer in the PR, and diff lines in and out, and stays right across rebases and force-pushes (new commits with
  the same diff count as no change). Cached per head; one `gh api` call per new head.
- **Questions**: select text inside the guide and an "Ask about this" button floats under it (docked at the bottom on
  phones); every section also has an "Ask about this section" link (shown on hover, always on touch). The thread keeps
  the selected passage, and follow-ups go in the same thread. Each question is a `scrutinize-ask` job (💬; resumable,
  and a no-op if the question already has its answer) running the same kind of headless run against the code **as the
  guide saw it** (the head it was written at). The run answers in JSON (`parseAnswer`):
  - `reply`: shown in the thread (the usual case);
  - `addendum`: appended to the section under "**Addendum** (asked: “…”)", with a short note in the thread;
  - `rewrite`: replaces the section's body (its heading stays), with a short note in the thread.

  Headings in model-written content are pushed down to `####`, so an answer never splits or renumbers sections
  (`doc.ts`). Removing a thread (✕, confirmed) leaves what it changed in the guide.
- **Sections** (`doc.ts`): a heading of level 1–3 and everything up to the next one; ids are slugs of the heading. The
  web tab draws each section's Markdown separately so threads can sit under the section they're about.
- The runs are named `wh-scrutinize:…` and hidden with `ctx.sessions.hide` (they can run inside a recorded checkout),
  with `--no-session-persistence` and `--strict-mcp-config`.

## The `/work-hub:scrutinize-pr` skill

`skills/scrutinize-pr/` (the manifest's `skills`) is a Claude Code skill: `/work-hub:scrutinize-pr [PR]` in a session
starts a summary, the same as the tab's button. The argument may be a number (a PR in the session's repo),
`owner/repo#n` or a PR URL. Without one, the skill picks the most likely PR (`scrutinize-pr.ts candidates`, beside the
SKILL.md: the PR of the folder's branch, the session's work-hub workspace's PR links and its worktrees' branch PRs, plus
whatever the conversation was about), and asks with `AskUserQuestion` when it isn't clearly one.

- **Only while the plugin is active**: the core links the skill into its shared `work-hub` Claude plugin at startup only
  when this plugin is active, and passes that plugin to every session the app starts. Turn the plugin off (and restart
  work-hub) and the skill is gone; `/reload-plugins` in a running session picks that up, either way. A session started
  before work-hub had the shared plugin needs a new session. Never installed at user scope.
- **How it reaches the server**: not over HTTP (with a hostname set, the guard refuses loopback requests and wants a
  sign-in cookie, and that stays as it is). `scrutinize-pr.ts start <PR> [--wait]` writes `<id>.json` into
  `<state dir>/plugins/scrutinize-pr/requests/` (0700; `WORK_HUB_STATE_DIR` or its default). The server watches the
  folder from `onStart` (`requests.ts`: a pass on every change and every 10s), takes each request (deletes it), and
  answers in `<id>.response.json`: `started` (with `jobId`, the tab's `url` and the summary's `path`), or `running` (one
  is already being written), then `done` or `failed` when the job ends. A request for another GitHub host than the
  github plugin's is refused; one over an hour old (work-hub was down) is refused rather than started late; answers are
  deleted after a day. Whoever can write that folder is already the user, as with `wh` and `hub.db`.
- The script waits 15s for `started` (or, with `--wait`, until `done`/`failed`, up to 30 min) and prints the answer as
  JSON for the skill to relay.

## Storage

`<state dir>/plugins/scrutinize-pr/prs/<host>/<owner>/<repo>/<number>/`:

- `summary.md`: the guide, addenda and rewrites included;
- `meta.json`: when it was written and last updated, at which head, the merge base, mode, model, the PR's size then, the file
  snapshot for "changed since", and the question threads;
- `history/summary-<time>.md`: earlier versions.

The folder is added to the file viewer (`ctx.files.addRoot`), so a session can be pointed at a summary.

## Routes

All under `/api/plugins/scrutinize-pr/prs/:owner/:repo/:number` (`:owner`/`:repo`/`:number` validated by the github
service's `parseRef`; 503 while the github plugin is off).

| route | body | answer |
| --- | --- | --- |
| `GET …?head=<sha>` | | `SummaryView` (`types.ts`): the guide, its age, head, model, mode, stats, `since` (when `head` differs), threads, `generating`, the last failure. ETag-revalidated |
| `POST …/generate` | `{}` | `202 { ok, jobId }`; 409 while one is being written |
| `POST …/update` | `{}` | `202 { ok, jobId }`; 409 while it's being written or updated |
| `POST …/ask` | `{ sectionId, quote?, question }` for a new thread, `{ threadId, question }` for a follow-up | `202 { ok, jobId, threadId }`; 400 no summary, unknown section or thread, empty or too long question (4000), or a thread still waiting |
| `POST …/threads/remove` | `{ threadId }` | `{ ok }` |

## Slots

- `pr-tab` `summary`: the Summary tab (`SummaryTab.tsx`). The slot was added for this plugin (CHANGELOG, 2026-11-06).
- `job-kind` `scrutinize` (🔎), `scrutinize-update` (🔁) and `scrutinize-ask` (💬).

Manifest `skills`: `skills/` (the core's shared `work-hub` Claude plugin). Server hooks: `sessions.hide`, `files.addRoot`,
`jobs.registerResumer`, `onStart` (the requests watcher).

## Settings

| key | env | default | what |
| --- | --- | --- | --- |
| `model` | `WORK_HUB_SCRUTINIZE_PR_MODEL` | `opus` | writes the guides and answers the questions |

## Low data

The tab loads when it's opened (a tap) and when the PR's head moves; it polls only while a guide or an answer is being
written (3s, 10s in Low data), and the GET is ETag-revalidated, so an unchanged poll is an empty 304. The "changed since"
check costs one GitHub call per new head, on the server.

## Caveats

- Writing a guide takes minutes and spends tokens on every click; nothing runs by itself.
- Line links point at the head commit the guide was written at, so they stay valid after the PR moves on (until that
  commit is garbage-collected on GitHub after a force-push).
- The diff-lines count is a multiset comparison of changed lines, so moving an identical line within a file counts as no
  change.
