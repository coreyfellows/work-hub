# github

Pull requests through the `gh` CLI that is already signed in on this machine (no tokens stored): the PR lists, an
in-app PR preview with review threads, checks and merging, "Start session" on a PR, and linking PRs to workspaces.

## What it does

- **Source `github`** ("Pull requests", every 2 minutes by default; polled through the registry, so only while someone
  is watching). One GraphQL search per list: `mine` (my open PRs), `reviewRequested` (open, waiting on my review) and
  `merged` (mine, merged in the last `mergedDays` days, newest first; kept apart from `mine`, which the health issue
  and the PR linking read). `data.host` is the GitHub host.
- **GitHub file links** (`GithubFileLink.tsx`, a `markdown-override` for `a`): anywhere Markdown is drawn (Chat, the PR
  page, the scrutinize-pr summary…), a `https://<host>/<owner>/<repo>/blob/<ref>/<path>#L10-L20` link on the host gh
  uses opens the file in a modal, the linked lines marked and scrolled to, with "Open on GitHub ↗" (Markdown files: a
  Rendered/Source switch, Source when the link names lines); ⌘/Ctrl/Shift/middle
  click still opens GitHub. Other absolute links open in a new tab. Parsing is `blobUrl.ts` (tested); a ref with slashes
  is tried shortest first.
- **PR lists**: `/prs` (nav "PRs", badge = non-draft PRs waiting on my review) shows "Needs my review" and "My PRs",
  flat and open-only. A workspace's Details → **Pull requests** section (`workspace-section` `prs`, order 20, between
  Links and Worktrees) shows the PRs on its worktrees' branches, grouped Draft / Open / Merged; merged rows show when
  they merged and offer no Start session. Its URLs are left out of the Links section (`shownUrls`).
- **PR "Start session" / "Review with Claude"** (`prSession.ts`, `POST /api/prs/session`, a `pr-session` job in the
  header tray, not resumable): reuse the worktree that has the branch, else create
  `<worktrees root>/<repo>/<TICKET|review-N>` (fetching the branch), trust it with the ticket-workflow
  plugin's `trust-worktree.sh` (the core's `ctx.sessions.trustWorktree` while that plugin is off and `WORK_HUB_TW_SCRIPTS` is unset), start `claude --bg` there (my PR: `modelMine`, someone else's: `modelReview`) and record it in
  the workspace model: my PR joins the workspace that owns its worktree, a review gets its own workspace, and a
  workspace already linking the PR keeps it. My PR's workspace also gets a Jira link when the branch or title names a
  ticket. The prompt ends with the workspace rules (`ctx.prompts.workspaceRules`). A session linked to a PR (its cwd
  has the PR's branch, `linked()` in `linked.ts`) shows as "Session ▸" instead.
- **PR preview** (`/prs/:owner/:repo/:number`, `prDetail.ts` + `PrPage.tsx`; diff rendering is the core's `DiffTable`).
  PR titles in the lists (and PR links on a workspace) open it; ↗ still goes to GitHub. Fetched on demand through `gh`
  (no registry, no tokens): one GraphQL query for body, comments, reviews, review threads (each with its `diffHunk`),
  checks (with `isRequired`) and merge settings; REST `pulls/:n/files` for the patches, re-fetched only when the head
  commit changes. The page re-polls every 30s while visible (Low data: on tap, with "as of"). Tabs: Conversation
  (timeline; each thread shows the tail of its hunk with the commented lines tinted, reply/resolve, "View in file"),
  Files (full diff, threads under their line by side+line; outdated ones at the top of the file), Checks. The merge
  box offers "Ready for review" on a draft PR (GraphQL `markPullRequestReadyForReview`), explains what blocks merging (review decision, failing/pending required checks, unresolved threads, conflicts)
  and offers Merge (confirm popover, GraphQL `mergePullRequest` pinned to `expectedHeadOid` so it refuses if the
  branch moved), auto-merge on/off, and "Merge as admin" (`gh pr merge --admin --match-head-commit`) only when GitHub
  says the viewer can bypass. Branch deletion only for same-repo heads when the repo doesn't already delete on merge.
  Readability: identical comments from one author (bots re-posting a status) collapse into one entry at the latest
  time ("posted N times"); comments and reviews taller than ~320px are clamped behind "Show more"; `<!-- -->` is
  stripped, other raw HTML skipped, and common `:emoji:` shortcodes mapped. Other plugins add buttons to the page's
  header through the `pr-action` slot (the core's "Adversarial review" is one), and whole tabs after Checks through the
  `pr-tab` slot (scrutinize-pr's Summary). A tab's `id` is its URL hash; a hash naming no tab (a plugin that is off)
  shows the conversation. The merge box shows on Conversation and Checks only.
- **PR linking** (`prLinks.ts`, a reconcile pass via `ctx.reconcile.addPass`): PRs go to a workspace from its jobs'
  `~/.claude/jobs/<id>/state.json` `children` (kind `pr`: PRs the job opened or worked on) and from open PRs (mine and
  review-requested) whose branch is exactly one recorded worktree's (never main/master/develop/dev/trunk); a URL some
  workspace already links is never claimed again. Every change to the `github` source asks for a pass
  (`ctx.reconcile.run()`); the core runs one after every sessions change too.
- **Worktree rows** (`worktree-action` `pr`, order 50): "PR #n" (opens the preview) once a PR exists for the branch,
  else "Create PR ↗" (GitHub's compare page against the recorded base), hidden when the branch has no diff vs its
  merge base. That last bit comes from `GET /api/workspaces/:id/pr-changes` (the worktree diff's route, called by URL;
  if it's missing nothing is known and the link shows), polled every 30s, only on open/worktree change in Low data.
- **Workspace cards** (`workspace-card` `prs`): on the front page, a chip per PR on a workspace's card ("PR #n" and
  the most pressing thing about it: merged, conflicts, checks failing, changes requested, N unresolved, checks running,
  draft, approved, needs review, open; `prChip.ts`), opening the PR preview; the tooltip lists every fact.
- **Palette** (`palette-items`): every open PR (mine and review-requested), opening its preview.
- **Health** (`health-issues`, order 110): a `fire` issue per non-draft PR of mine with changes requested.
- **Job icon** (`job-kind`): `pr-session` ⑂.

## Routes

| Route | What |
| --- | --- |
| `GET /api/prs/:owner/:repo/:number` | the PR in detail (`PrDetail`); ETag-revalidated |
| `GET /api/prs/:owner/:repo/:number/files` | the changed files with patches (`PrFile[]`); ETag-revalidated |
| `POST /api/prs/:owner/:repo/:number/comment` | `{ prId, body }` → the new comment |
| `POST /api/prs/:owner/:repo/:number/threads/reply` | `{ threadId, body }` → the new reply |
| `POST /api/prs/:owner/:repo/:number/threads/resolve` | `{ threadId, resolved? }` |
| `POST /api/prs/:owner/:repo/:number/merge` | `{ method, expectedHeadOid, admin?, deleteBranch? }` |
| `POST /api/prs/:owner/:repo/:number/ready` | none; marks a draft PR ready for review |
| `POST /api/prs/:owner/:repo/:number/auto-merge` | `{ enable?, method?, expectedHeadOid? }` |
| `GET /api/plugins/github/blob?url=` | the file a blob link points at (`{ ref, path, size, truncated, binary, content }`, first 1 MB) via `gh api` contents; links on another host 502, files at a full SHA cached in memory |
| `POST /api/prs/session` | `PrRef` → `202 { jobId }` (a `pr-session` job) |

Bad `owner`/`repo`/`number` params answer 400; a failing `gh` call 502 with its message. Writes refresh the source.

## Service

`ctx.services.get<GithubService>('github')` (type in `types.ts`): `host()` (async), `parseRef`, `prDetail`, `prFiles`,
`ensureBranchWorktree(repoName, repo, branch, folder)` (the worktree that has the branch: reused, else created and
trusted) and `data()` (the latest lists). The core's adversarial review uses it for PR reviews and answers 503 while
this plugin is off. Types for both halves and other plugins (`PullRequest`, `GithubData`, `PrDetail`, `PrThread`,
`PrComment`, `PrCheck`, `PrFile`, `PrRef`) live in `types.ts`.

## Settings

Read with `ctx.config.get`: env `WORK_HUB_GITHUB_<KEY>` first, then `plugins.json` `settings.github.<key>`; the old env
names still work as defaults.

| key | default | old env |
| --- | --- | --- |
| `host` | the first host `gh auth status` says you're logged in to, else `github.com` | `WORK_HUB_GH_HOST` |
| `intervalMs` | `120000` | `WORK_HUB_GH_INTERVAL_MS` |
| `mergedDays` | `7` | `WORK_HUB_GH_MERGED_DAYS` |
| `modelMine` | `sonnet` (getting my own PR merged is usually well-scoped) | `WORK_HUB_PR_MODEL_MINE` |
| `modelReview` | `opus` (reviewing someone else's needs more judgment) | `WORK_HUB_PR_MODEL_REVIEW` |
| `jiraBaseUrl` | empty: no Jira links (e.g. `https://your-site.atlassian.net`) | `TW_JIRA_BASE_URL` |

Repos are looked up in the core's repos folder and new worktrees go under its worktrees root, both from `ctx.paths`
(Settings → Folders; `WORK_HUB_REPOS_DIR` / `TW_WORKTREES_ROOT` override).

## Caveats

- With neither the setting nor `WORK_HUB_GH_HOST`, the host comes from `gh auth status` on first use (never during
  startup). Only a host it actually names is kept; until then each call falls back to `github.com` and asks again.
- A PR session's new workspace gets its note from the notes plugin (on the workspace's `created` event), not from here.
- The "preview" link next to a PR in Details → Links (`/prs/…`) is still drawn by the core's Links section, so it
  leads to an unknown page while this plugin is off.
