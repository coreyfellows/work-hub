# Session Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session work-hub starts in a workspace gets a compact, server-derived picture of its sibling sessions at start and a few lines when a sibling changes, at no token cost when nothing changed.

**Architecture:** A new official plugin `session-awareness` builds one digest per workspace (a block per open session: status, claim/done lines, worktree and PRs, last commits, edited files and overlaps) from the store, the live sessions list, the github service and git; it rebuilds on in-process events and on a file watch of `hub.db`, writes JSON + Markdown under its plugin state folder, adds the Markdown to start prompts, and passes a Node hook (via `--settings`) that reads the files and reports only changed sibling blocks. Small additive core changes give events a session id, add `wh claim`/`wh done`, and expose what the plugin reads through `plugin-api`.

**Tech Stack:** Node 26 TypeScript (type stripping, `.ts` imports, no enums), Hono, `node:sqlite`, `node:test`, React (web), plain `.mjs` for the hook.

**Spec:** `docs/superpowers/specs/2026-11-06-session-awareness-design.md`

## Global Constraints

- Plugin imports only `plugin-api/*`, npm and its own folder (`server/plugins/boundary.test.ts` enforces it); core never imports `plugins/`.
- No new polling source, no timer in the plugin: triggers are `session-started`, `session-stopped`, `workspace-event`, `source-changed` (`claude`, `github`) and the `hub.db` file watch.
- The hook never calls the server over HTTP, never blocks a turn, exits 0 silently on any error, and prints nothing when nothing changed.
- Size caps: a block ≤ `maxBlockChars` (default 600), a digest ≤ 4 000 characters; nudges ≤ 5 lines.
- Staleness: live facts (status, PRs) older than `staleAfterMs` (default 600000) are stamped "(status as of …: work-hub was idle)", never shown as current.
- `events.session_id` holds the full Claude session UUID, never a job id.
- Everything stays in TypeScript the server runs directly; `pnpm typecheck` and `pnpm test` green before every commit.
- Windows/Linux: Node hook, `team.sh` + `team.ps1`; README says the Windows half is untested.
- Work-hub shipping rule: commit on the `session-awareness` branch as you go; the last task merges into `main`, pushes and deploys.

## Review Focus

- A workspace with one session: no "Other sessions" prompt text, no Details section, hook prints nothing. (Task 4 render test, Task 6 fragment test, Task 7 hook test.)
- A session whose transcript is missing or unreadable: `sessionEdits` returns null; the block simply has no files line and the rebuild never throws. (Task 5 collect test.)
- `hub.db-wal` is created and removed by SQLite checkpoints: the watcher must watch the directory, not the file, and keep firing after the WAL file is replaced. (Task 5 watch test.)
- A session's `sessions/<id>.json` points at a workspace whose digest was removed (workspace done): the hook exits silently. (Task 7 hook test.)
- The hook gets empty or malformed stdin, or no `session_id`: exits 0 with no output, well under its timeout. (Task 7 hook test.)

---

### Task 1: Events carry a session id; `listEvents`

**Files:**
- Modify: `server/store/db.ts` (append migration 15)
- Modify: `server/store/workspaces.ts:38-42` (`WorkspaceEvent`), `:86-90` (`logEvent`), `:215` (hydrate's events select), add `listEvents`
- Modify: `server/lib/events.ts:10` (`workspace-event` payload)
- Modify: `server/store/pluginMigrations.test.ts:14-18` (version 14 → 15)
- Test: `server/store/events.test.ts` (new)

**Interfaces:**
- Produces: `logEvent(workspaceId: string, type: string, detail?: string, sessionId?: string | null): void`; `listEvents(workspaceId: string, opts?: { types?: string[]; sessionId?: string; limit?: number }): WorkspaceEvent[]` (newest first; `limit` default 50); `WorkspaceEvent` gains `sessionId: string | null`; `HubEvents['workspace-event']` gains `sessionId: string | null`.

- [ ] **Step 1: Write the failing test** `server/store/events.test.ts`, using a temp `WORK_HUB_STATE_DIR` or an in-memory DB the way `pluginMigrations.test.ts` does (`createWorkspace` needs `getDb()`; set `process.env.WORK_HUB_STATE_DIR` to a `mkdtemp` folder before importing the store).

```ts
test('logEvent stores the session id and listEvents filters by type and session', () => {
  createWorkspace({ id: 'w', title: 'W' });
  logEvent('w', 'claim', 'the API', 'aaaa-1');
  logEvent('w', 'done', 'tests', 'aaaa-1');
  logEvent('w', 'claim', 'the UI', 'bbbb-2');
  logEvent('w', 'note', 'unattributed');
  assert.deepEqual(listEvents('w', { types: ['claim'] }).map((e) => [e.detail, e.sessionId]), [['the UI', 'bbbb-2'], ['the API', 'aaaa-1']]);
  assert.deepEqual(listEvents('w', { sessionId: 'aaaa-1' }).map((e) => e.type), ['done', 'claim']);
  assert.equal(listEvents('w', { types: ['note'] })[0].sessionId, null);
  assert.equal(getWorkspace('w')!.events[0].sessionId, null); // hydrate reads the column too
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test server/store/events.test.ts`
Expected: FAIL (`listEvents` is not exported / `sessionId` undefined).

- [ ] **Step 3: Implement** migration 15 `ALTER TABLE events ADD COLUMN session_id TEXT;` with a comment in the file's style; `logEvent`'s 4th parameter written to the column and included in the emitted payload; `listEvents` as one prepared statement built from the options (`type IN (…)`, `session_id = ?`, `ORDER BY at DESC, id DESC LIMIT ?`); hydrate selects `session_id` and maps it to `sessionId`.

- [ ] **Step 4: Run the tests**

Run: `node --test server/store/events.test.ts server/store/pluginMigrations.test.ts` (after changing the expected version to 15), then `pnpm typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Store: events carry the session that logged them; listEvents"`

### Task 2: Who is calling `wh`? `wh claim`, `wh done`, attribution

**Files:**
- Create: `server/lib/callerSession.ts`
- Test: `server/lib/callerSession.test.ts`
- Modify: `scripts/wh.ts` (USAGE, `log`, `link add`, new `claim` and `done` cases)

**Interfaces:**
- Produces: `callerSessionId(env: NodeJS.ProcessEnv, readJobSessionId: (jobId: string) => string | null, explicit?: string): string | null` (pure, order from the spec: explicit → job dir when `CLAUDE_CODE_CHILD_SESSION` is set → `CLAUDE_CODE_SESSION_ID` → job dir → null); `readJobSessionIdSync(jobId: string, jobsDir?: string): string | null` (reads `<jobsDir>/<jobId>/state.json` `sessionId`, no retry, null on any error); `wh claim <ws> <text…>`, `wh done <ws> <text…>` log events `claim` / `done` with the caller's session id; `wh log` and `wh link add` (event type `link`, detail = url) attribute the same way; all accept `--session <uuid>`.

- [ ] **Step 1: Write the failing tests** `server/lib/callerSession.test.ts`

```ts
const job = (id: string) => (id === 'job1' ? 'uuid-from-job' : null);
test('explicit --session wins', () => assert.equal(callerSessionId({ CLAUDE_CODE_SESSION_ID: 'u' }, job, 'x'), 'x'));
test('a subagent is attributed to its job, not its own child session id', () =>
  assert.equal(callerSessionId({ CLAUDE_CODE_SESSION_ID: 'child', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_JOB_DIR: '/h/.claude/jobs/job1' }, job), 'uuid-from-job'));
test('CLAUDE_CODE_SESSION_ID before the job dir', () =>
  assert.equal(callerSessionId({ CLAUDE_CODE_SESSION_ID: 'u', CLAUDE_JOB_DIR: '/h/.claude/jobs/job1' }, job), 'u'));
test('job dir alone resolves through state.json; an unknown job is unattributed', () => {
  assert.equal(callerSessionId({ CLAUDE_JOB_DIR: '/h/.claude/jobs/job1' }, job), 'uuid-from-job');
  assert.equal(callerSessionId({ CLAUDE_JOB_DIR: '/h/.claude/jobs/nope' }, job), null);
  assert.equal(callerSessionId({}, job), null);
});
test('readJobSessionIdSync reads sessionId from state.json and is null otherwise', () => { /* mkdtemp, write state.json, assert; missing file → null */ });
```

- [ ] **Step 2: Run them to see them fail** `node --test server/lib/callerSession.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `server/lib/callerSession.ts`** (Node builtins only: `fs`, `path`, `os`).

- [ ] **Step 4: Run the tests** → PASS.

- [ ] **Step 5: Extend `scripts/wh.ts`**: `const caller = () => callerSessionId(process.env, (j) => readJobSessionIdSync(j), v.session)`; cases `claim` and `done` (`need(sub)`, text = `rest.join(' ').trim()`, die on empty, `logEvent(ws, cmd, text, caller())`, print `claimed on <ws>` / `recorded done on <ws>`); `log` passes `caller()`; `link add` logs `logEvent(ws, 'link', url, caller())` after `addLink`; USAGE gains the two lines (`wh claim <ws> <text>   what this session is responsible for (latest wins)` and `wh done <ws> <text>    something this session finished`) and `[--session <uuid>]` on `log`.

- [ ] **Step 6: Check by hand** from this session (it has `CLAUDE_CODE_SESSION_ID`):

Run: `bin/wh claim work-hub "plan check" && node -e "import('./server/store/workspaces.ts').then(m=>console.log(m.listEvents('work-hub',{types:['claim'],limit:1})))"`
Expected: one event with `sessionId` equal to `$CLAUDE_CODE_SESSION_ID`. Then `bin/wh log work-hub note "cleanup"` prints nothing and exits 0.

- [ ] **Step 7: `pnpm typecheck && pnpm test`, commit** `git commit -m "wh claim / wh done; wh attributes events to the calling session"`

### Task 3: `ctx.sessions.boundWorktrees` and the CHANGELOG

**Files:**
- Modify: `plugin-api/server.ts:178-212` (sessions block), `server/index.ts:123-137` (deps.sessions)
- Modify: `CHANGELOG.md` (an "Additions" entry under Plugin API 1.0)
- Test: `server/plugins/context.test.ts` or the existing context test file, one assertion

**Interfaces:**
- Produces: `ctx.sessions.boundWorktrees(sessionId: string): string[]` (= `server/store/sessionWorktrees.ts` `boundWorktrees`); `ctx.store.listEvents` is already there via `typeof workspacesStore`.

- [ ] **Step 1: Add a failing assertion** to the existing plugin-context test (find it with `grep -ln "createContext\|buildContext" server/plugins/*.test.ts`): the built context's `sessions.boundWorktrees` is a function returning `[]` for an unknown id.
- [ ] **Step 2: Run it** → FAIL.
- [ ] **Step 3: Implement**: type in `plugin-api/server.ts` (doc comment: "Worktrees a session created or moved into, besides its start folder (reconcile's transcript scan)"), wired in `server/index.ts` deps.
- [ ] **Step 4: Run it** → PASS; `pnpm typecheck`.
- [ ] **Step 5: CHANGELOG** under "Plugin API 1.0" add an "Additions (2026-11-06)" list: `events.session_id` + `logEvent(…, sessionId?)`, `store.listEvents`, `WorkspaceEvent.sessionId`, `workspace-event` payload `sessionId`, `ctx.sessions.boundWorktrees`, `wh claim` / `wh done` and attribution. Follow the file's existing style for additions.
- [ ] **Step 6: Commit** `git commit -m "Plugin API: sessions.boundWorktrees; changelog for the events session id"`

### Task 4: The plugin skeleton and the pure digest builder

**Files:**
- Create: `plugins/session-awareness/plugin.json`, `plugins/session-awareness/digest.ts`, `plugins/session-awareness/server.ts` (register that does nothing yet beyond `ctx.log.info`), `plugins/session-awareness/README.md` (a stub: title + one line; filled in Task 10)
- Test: `plugins/session-awareness/digest.test.ts`

**Interfaces:**
- Produces (all in `digest.ts`, pure, no I/O):

```ts
export interface DigestInput {
  workspaceId: string;
  now: number;                       // ms
  liveAt: number | null;             // when status/PR facts were last refreshed (claude source), null = never
  sessions: Array<{ sessionId: string; shortId: string; name: string | null; role: string; status: string; intent: string | null; startedAt: number; lastActiveAt: number | null; branch: string | null; repo: string | null }>;
  worktrees: Record<string, { path: string; repo: string; branch: string | null; baseBranch: string | null }[]>; // sessionId → worktrees (start folder first, then bound)
  events: Array<{ at: string; type: string; detail: string | null; sessionId: string | null }>; // claim / done / link
  prs: Array<{ number: number; title: string; url: string; repo: string; branch: string; isDraft: boolean; checks: string | null }>;
  commits: Record<string, Array<{ sha: string; subject: string }>>;  // worktree path → up to 3, newest first
  edits: Record<string, Array<{ path: string; at: number | null }>>; // sessionId → files edited (absolute paths)
  maxBlockChars: number;             // 600
  maxDigestChars: number;            // 4000
  overlapWindowMs: number;           // 2h
}
export interface Block { sessionId: string; shortId: string; name: string | null; role: string; status: string; started: string; active: string | null; intent: string | null; claim: string | null; done: string[]; worktree: { path: string; branch: string | null; base: string | null } | null; prs: Array<{ number: number; title: string; url: string; state: 'draft' | 'open'; checks: string | null }>; commits: Array<{ sha: string; subject: string }>; files: Array<{ path: string; alsoBy: string[] }>; version: string }
export interface Digest { workspaceId: string; builtAt: number; liveAt: number | null; blocks: Block[] }
export function buildDigest(input: DigestInput): Digest;
export function bucket(ms: number, now: number): string;                  // 'just now' | '5m' | '30m' | '2h' | 'today' | 'older'
export function renderBlock(b: Block, opts: { stale: boolean; liveAt: number | null; now: number }): string; // Markdown, ≤ maxBlockChars already enforced in buildDigest
export function renderDigest(d: Digest, opts: { excludeSessionId?: string; staleAfterMs: number; now: number }): string; // '' when no blocks remain
```

Rules the implementer needs: `status` is the normalised one from the sessions list; a block's `version` is a short hash (`createHash('sha1')` over the block JSON without `version`) and must not change when only `active`/`started` buckets or timestamps move (compute it over everything except `started` and `active`); claim = detail of the newest `claim` event for that session, done = details of the newest 3 `done` events (newest first); PRs = `prs` whose `repo` (case-insensitive) and `branch` equal the block's worktree branch and repo (fall back to the session's own `repo`/`branch`), `state` is `draft` when `isDraft`; files = distinct paths from `edits` (newest first, up to 8), shown relative to the worktree path (or the last two path segments when outside it); `alsoBy` = short ids of other blocks whose edits include the same absolute path with `at` within `overlapWindowMs` of now (null `at` counts); trimming order when a block exceeds `maxBlockChars`: oldest done lines, then commits, then files, then intent; when the digest exceeds `maxDigestChars`, drop files from every block, then commits, then done; `renderDigest` orders blocks: working, needs-input, idle, failed, then by shortId.

- [ ] **Step 1: Write the failing tests** `digest.test.ts` (fixtures as small literals; `now = 1_000_000_000_000`).

```ts
test('one block per session with claim, last three dones, PRs on its branch and commits', …)      // asserts block.claim, block.done.length === 3 (newest first), block.prs[0].number, block.commits
test('files are relative to the worktree, capped at 8, and overlaps name the other session', …)   // files[0].alsoBy deepEqual ['9c1d'], an edit 3h old does not count
test('version is stable across status-time buckets but changes on a new PR or claim', …)
test('a block over maxBlockChars drops dones, then commits, then files, and never exceeds the cap', …) // renderBlock(b).length <= 600
test('renderDigest excludes the asker, returns "" with no siblings, and stamps stale live facts', …) // contains '(status as of' when now - liveAt > staleAfterMs; not otherwise
test('bucket', () => { assert.equal(bucket(now - 30_000, now), 'just now'); … 'older' })
```

- [ ] **Step 2: Run** `node --test plugins/session-awareness/digest.test.ts` → FAIL (module missing).
- [ ] **Step 3: Write `plugin.json`**: id `session-awareness`, apiVersion 1, title "Session awareness", description "Gives every session in a workspace a short, server-derived picture of its sibling sessions (what they own, their PRs, what they finished), refreshed only when something changes", `defaultEnabled: true`, `server`, `web` (added in Task 9; leave out until then), `settings`: `nudgeIntervalMs` (number, 300000, min 0, max 3600000), `maxBlockChars` (number, 600, min 200, max 2000), `startPrompt` (boolean, true), `staleAfterMs` (number, 600000, min 60000, max 86400000); labels in Settings' plain style.
- [ ] **Step 4: Implement `digest.ts`** to the interfaces above.
- [ ] **Step 5: Run the tests** → PASS; `pnpm typecheck`; `pnpm test` (the boundary test now sees the plugin).
- [ ] **Step 6: Commit** `git commit -m "session-awareness plugin: manifest and the pure digest builder"`

### Task 5: Collecting the inputs, the files on disk, the DB watch

**Files:**
- Create: `plugins/session-awareness/collect.ts`, `plugins/session-awareness/files.ts`, `plugins/session-awareness/watch.ts`
- Test: `plugins/session-awareness/collect.test.ts`, `plugins/session-awareness/files.test.ts`, `plugins/session-awareness/watch.test.ts`

**Interfaces:**
- Consumes: `buildDigest` (Task 4); `ctx.store.getWorkspace/listEvents`, `ctx.sessions.list/boundWorktrees/sessionEdits`, `ctx.services.get<GithubService>('github')?.data()`, `ctx.exec.run`, `ctx.git.baseRef`.
- Produces:

```ts
// collect.ts
export interface Collector { collect(workspaceId: string): Promise<Digest | null> }  // null when the workspace is missing or done
export function createCollector(deps: {
  getWorkspace: (id: string) => Workspace | null;
  listEvents: (id: string, o: { types: string[]; limit: number }) => WorkspaceEvent[];
  liveSessions: () => Session[];                 // ctx.sessions.list()
  liveAt: () => number | null;                   // when the claude source last changed (server.ts tracks it)
  boundWorktrees: (sessionId: string) => string[];
  sessionEdits: (sessionId: string) => Promise<FileEdit[] | null>;
  prs: () => DigestInput['prs'];                 // [] when github is off
  gitLog: (cwd: string, base: string | null) => Promise<Array<{ sha: string; subject: string }>>;
  settings: () => { maxBlockChars: number };
  now?: () => number;
}): Collector;
export function createGitLog(run: (cmd: string, args: string[], o: { cwd: string; timeoutMs: number }) => Promise<string>, baseRef: (cwd: string, recorded: string | null) => Promise<string | null>): (cwd: string, base: string | null) => Promise<Array<{ sha: string; subject: string }>>; // caches per cwd by `git rev-parse HEAD`; `git log --format=%h%x09%s -n 3 <base>..HEAD`; [] on any error
// files.ts
export function digestPaths(dir: string, workspaceId: string): { json: string; md: string };
export function sessionMapPath(dir: string, sessionId: string): string;      // <dir>/sessions/<sessionId>.json
export async function writeDigest(dir: string, digest: Digest, md: string): Promise<void>;  // atomic (tmp + rename), also writes sessions/<id>.json {workspaceId} for every block, removes stale ones for this workspace
export async function removeDigest(dir: string, workspaceId: string): Promise<void>;
export async function readDigest(dir: string, workspaceId: string): Promise<Digest | null>;
// watch.ts
export function watchDb(dbPath: string, onChange: () => void, debounceMs = 500): () => void;   // fs.watch on dirname(dbPath), filters basename(dbPath) and basename + '-wal'
```

Sessions in the digest: the workspace's `sessions` records joined to `liveSessions()` by `claudeSessionId`; keep those with a live match whose status is not `done`/`stopped`; a recorded session with no live match is left out. Worktrees per session: the recorded worktree containing the live session's `cwd` first, then `boundWorktrees` paths that are recorded worktrees. Commits: for the first worktree of each block.

- [ ] **Step 1: Write the failing tests**

```ts
// collect.test.ts: fake deps; two sessions in one workspace
test('collect joins recorded sessions to live ones, skips done/stopped and unknown, and survives a missing transcript', …) // sessionEdits rejects for one session → that block has files [] and collect resolves
test('collect returns null for a missing or done workspace', …)
test('createGitLog caches by HEAD and returns [] when git fails', …)          // run called for rev-parse twice, log once
// files.test.ts (mkdtemp)
test('writeDigest writes json+md atomically and a session map per block; removeDigest clears them', …)
// watch.test.ts (mkdtemp; create hub.db, start watching, append to hub.db-wal; also delete and recreate the wal)
test('watchDb fires once per burst and keeps firing after the wal file is replaced', …)
```

- [ ] **Step 2: Run** the three files → FAIL.
- [ ] **Step 3: Implement** the three modules to the interfaces. `watch.ts`: `fs.watch(dir, { persistent: false })`, debounce with `setTimeout(...).unref()`; on `error` log once and stop.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit** `git commit -m "session-awareness: collect digest inputs, write files, watch hub.db"`

### Task 6: Wiring the server half: triggers, route, prompt fragments

**Files:**
- Modify: `plugins/session-awareness/server.ts`
- Create: `plugins/session-awareness/rules.ts` (the two rules lines + the on-demand command, pure)
- Modify: `builtin/session-tools/handoff.ts:31-50` (`continuePrompt(ws, old, brief, transcript, note, rules, context: string | null = null)`: a new trailing optional parameter, rendered as its own paragraph between the transcript line and `rules` when non-empty; the call site passes `ctx.prompts.fragments('session-context', { workspaceId: ws.id, ticketKey: ws.ticketKey })`), `plugins/github/prSession.ts:33-51` (push the same fragments before the rules)
- Test: `plugins/session-awareness/server.test.ts`, `builtin/session-tools/handoff.test.ts` (or extend the existing one), `plugins/github/prSession.test.ts` (one assertion)

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces: `GET /api/plugins/session-awareness/workspaces/:id/digest` → `Digest` (404 `{ error: 'no digest' }` when none; registered with `ctx.revalidate`); fragment `session-context`: `"## Other sessions in this workspace\n\n" + renderDigest(…)` when `startPrompt` and the rendered text is non-empty (note: at start the asking session has no id yet, so nothing is excluded; the digest only holds already-running sessions); fragment `workspace-rules`: `rulesText(whCommand, teamCommand)` from `rules.ts`; `rebuild(workspaceId)` debounced 2 s per workspace; `rebuildAll()` on `source-changed` `claude`/`github` and on the DB watch; `session-started`/`session-stopped` → `rebuildAll()` (the workspace isn't known until reconcile runs; `rebuildAll` is cheap because unchanged digests are not rewritten); `workspace-event` → `rebuild(payload.workspaceId)`; `removeDigest` for workspaces that are done or gone.

`rules.ts`:

```ts
export function rulesText(whCommand: string, teamCommand: string): string
// Two sentences, exactly:
// `Tell your sibling sessions what you own: \`${whCommand} claim <ws> "<what you're responsible for>"\` when you take something on (latest wins) and \`${whCommand} done <ws> "<what you finished>"\` when you finish a piece. The "Other sessions in this workspace" block in your context is kept by work-hub from these and from your worktrees, PRs, commits and edits; you'll get a short note when a sibling's changes. For the current picture run \`${teamCommand} <ws>\`.`
```

`teamCommand` = `WORK_HUB_SESSION_AWARENESS_DIR=<pluginState> <pluginDir>/claude/scripts/team.sh` (Task 8 writes the script; the string is built here).

- [ ] **Step 1: Write the failing tests** with a fake context like `plugins/github/server.test.ts` (Hono app, `paths.pluginState` = mkdtemp, `events` = a tiny emitter, `prompts.addFragment` capturing fns, `sessions.list` returning fixtures, `store` fakes, `services.get` → undefined, `exec.run` rejecting).

```ts
test('GET digest is 404 before a build and 200 with blocks after a workspace-event', …)
test('session-context fragment is empty for a workspace with one session and holds the heading with two', …)
test('workspace-rules fragment names wh claim, wh done and team.sh', …)
test('startPrompt=false adds no session-context', …)
// handoff / prSession: the built prompt contains a marker string returned by a stub 'session-context' fragment
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `server.ts`**: read settings once per use via `ctx.config.get`; `liveAt` = `Date.now()` whenever `source-changed` for `claude` fires (initialise null); `watchDb(join(ctx.paths.stateDir, 'hub.db'), () => rebuildAll())` started in `ctx.onStart`, stopped on `process.once('exit')`; route with `ctx.revalidate([...])` before registering; fragments registered last (they can't be taken back if `register` throws, per CLAUDE.md, so put anything that can throw before them). Then the two prompt-builder edits.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck && pnpm test`.
- [ ] **Step 5: Try it live**: `pnpm dev` on a spare port (`WORK_HUB_PORT=4858`), with two sessions in a workspace run `bin/wh claim <ws> "x"` and confirm `<stateDir>/plugins/session-awareness/digests/<ws>.md` appears within ~3 s with no tab open. Stop the server by pid.
- [ ] **Step 6: Commit** `git commit -m "session-awareness: rebuild on events and DB changes, digest route, start-prompt and rules fragments"`

### Task 7: The hook

**Files:**
- Create: `plugins/session-awareness/claude/hooks/awareness.mjs`, `plugins/session-awareness/claude/hooks/changes.mjs`, `plugins/session-awareness/hookSettings.ts`
- Test: `plugins/session-awareness/changes.test.ts`, `plugins/session-awareness/hook.test.ts` (spawns the hook with stdin), `plugins/session-awareness/hookSettings.test.ts`
- Modify: `plugins/session-awareness/server.ts` (`ctx.sessions.addLaunchArgs(() => launchArgs({ hookPath, stateDir: ctx.paths.pluginState, nudgeIntervalMs, staleAfterMs }))`)

**Interfaces:**
- Consumes: digest JSON layout (Task 4), file paths (Task 5).
- Produces:

```js
// changes.mjs (pure, plain JS, no imports)
export function changeLines(prevBlocks /* Block[] | null */, nextBlocks /* Block[] */, selfSessionId, selfFiles /* string[] of the asker's own edited paths, from its own block */) // → string[]
// one line per sibling, prefixed 'work-hub: ', in this priority, first match per sibling: new session ("session 3f2a (name) started: <renderBlock-ish one-liner: claim or intent, branch>"), failed, status→needs-input ("is waiting on the user"), new PR ("opened PR #41 "title" on branch; checks pending"), checks changed ("PR #41 checks now failing"), claim changed ("is now responsible for: …"), new done ("finished: …"), new overlap ("edited <path>, which you also edited"); sessions that left ("session 3f2a is gone (done or stopped)"); at most 5 lines, then "…and N more changes; run team.sh for the full picture".
export function seenDiff(seen /* {[sessionId]: version} */, blocks) // → { changed: Block[], gone: string[] }
// hookSettings.ts
export function hookSettings(o: { hookPath: string; stateDir: string; nudgeIntervalMs: number; staleAfterMs: number }): { hooks: Record<string, unknown[]> }  // UserPromptSubmit always; PreToolUse (no matcher) only when nudgeIntervalMs > 0; command `WORK_HUB_SESSION_AWARENESS_DIR='<dir>' WORK_HUB_SESSION_AWARENESS_NUDGE_MS=<n> WORK_HUB_SESSION_AWARENESS_STALE_MS=<n> node '<hookPath>'`, timeout 5
export function launchArgs(o: Parameters<typeof hookSettings>[0]): string[]  // ['--settings', JSON]
```

`awareness.mjs` behaviour: read all stdin (JSON: `session_id`, `hook_event_name`); env `WORK_HUB_SESSION_AWARENESS_DIR` (required), `WORK_HUB_SESSION_AWARENESS_NUDGE_MS`; map file → workspace id (silent exit if absent); for `PreToolUse`, read `seen/<session_id>.json` `checkedAt` and exit if newer than `nudgeMs`; read the digest; compute `seenDiff` against the seen file's `versions`; if nothing changed write `checkedAt` and exit; else `changeLines(prevBlocksFromSeen?, …)`: the seen file stores the previous `blocks` too (so the hook can diff fields, not just versions), capped to the digest size; print `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":lines.join('\n')}}`; write the seen file (versions, blocks, checkedAt). Wrap everything in try/catch → `process.exit(0)`. Stale stamp: when `now - digest.liveAt > staleAfterMs` (pass `WORK_HUB_SESSION_AWARENESS_STALE_MS` in the command too), status-based lines are suppressed and a final line "(status as of <bucket>: work-hub was idle)" is appended when any line was emitted.

- [ ] **Step 1: Write the failing tests**

```ts
// changes.test.ts
test('a new sibling, a new PR, a changed claim, a new done and an overlap each produce one line; capped at 5 with a trailer', …)
test('the asker and unchanged siblings produce nothing; a vanished sibling says so', …)
// hook.test.ts: mkdtemp state dir with digests/w.json, sessions/<sid>.json; spawn `node awareness.mjs` with stdin JSON and env
test('first run prints additionalContext for every sibling and writes seen; second run prints nothing', …)
test('PreToolUse within nudge interval prints nothing even when changed; after it, prints', …)   // set checkedAt in seen file
test('no stdin, bad JSON, unknown session, missing digest: exit 0, empty stdout, under 2 s', …)
// hookSettings.test.ts
test('UserPromptSubmit always; PreToolUse only when nudgeIntervalMs > 0; env and paths quoted', …)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the three files and the `addLaunchArgs` line in `server.ts` (settings read inside the fn so a change applies to the next session).
- [ ] **Step 4: Run** → PASS; `pnpm typecheck && pnpm test`.
- [ ] **Step 5: Check the real hook once**: start a `claude --bg` from the dev server in a workspace with two sessions (or run `claude -p "say hi" --settings '<launchArgs JSON>'` in a recorded worktree whose session map file you write by hand) and confirm the transcript's first user turn carries the `work-hub:` lines. If `PreToolUse` `additionalContext` is ignored by the installed Claude Code, keep the hook on `UserPromptSubmit` only and note it in the README.
- [ ] **Step 6: Commit** `git commit -m "session-awareness: the nudge hook (UserPromptSubmit + throttled PreToolUse) passed via --settings"`

### Task 8: On-demand `team.sh` / `team.ps1`

**Files:**
- Create: `plugins/session-awareness/claude/scripts/team.sh` (executable), `plugins/session-awareness/claude/scripts/team.ps1`
- Test: `plugins/session-awareness/team.test.ts` (runs the `.sh` on macOS/Linux only)

**Interfaces:**
- Consumes: `<dir>/digests/<ws>.md` (Task 5); `rulesText` names the command (Task 6).
- Produces: `team.sh <ws>` prints the Markdown; with no digest prints `work-hub: no other sessions recorded for <ws>` and exits 0; dir from `WORK_HUB_SESSION_AWARENESS_DIR`, default `${WORK_HUB_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/work-hub}/plugins/session-awareness`; `set -euo pipefail`; no arguments → usage on stderr, exit 2.

- [ ] **Step 1: Write the failing test** (mkdtemp with a digest md; spawn the script; assert stdout; assert the no-digest message; assert exit 2 without args).
- [ ] **Step 2: Run** → FAIL. **Step 3: Write both scripts** (`chmod +x` the `.sh`; the `.ps1` mirrors it with `$env:WORK_HUB_SESSION_AWARENESS_DIR` and `$env:LOCALAPPDATA` fallback per `docs/windows.md`'s state-dir rule). **Step 4: Run** → PASS. **Step 5: Commit** `git commit -m "session-awareness: team.sh / team.ps1 print the digest on demand"`

### Task 9: The Details section

**Files:**
- Create: `plugins/session-awareness/web.tsx`, `plugins/session-awareness/SessionsGlance.tsx`, `plugins/session-awareness/styles.css`
- Modify: `plugins/session-awareness/plugin.json` (add `"web": "web.tsx"`)
- Test: `plugins/session-awareness/glance.test.ts` (pure helpers only: `isEmpty` logic and the status ordering live in a `.ts` helper imported by the component)

**Interfaces:**
- Consumes: `GET /api/plugins/session-awareness/workspaces/:id/digest` (Task 6), `Block`/`Digest` types (Task 4, type-only import), `get`, `ago`, `useLowData`, `useSource('claude')`, `Link`, `navigate` from `plugin-api/web.ts`, `AsOf` (export it from `plugin-api/web.ts` if it isn't; it is a core component at `web/src/components/AsOf.tsx`).
- Produces: `ctx.contribute('workspace-section', { id: 'sessions-glance', title: 'Sessions at a glance', order: 25, isEmpty: (ws) => ws.sessions.length < 2, component: SessionsGlance })`.

Behaviour: `SessionsGlance({ workspace })` fetches the digest when mounted; with Low data off it refetches when the `claude` or `workspaces` source's `updatedAt` changes (debounced 2 s); with Low data on it fetches once and shows `<AsOf at onRefresh>`; 404 → "No digest yet"; each block is a card: status dot (reuse the class the session tabs use for status: find it with `grep -rn "status-dot\|dot-" web/src/components/SessionTabs*.tsx` and use the same class names), name linking to `/sessions/<shortId>`, claim in bold, intent muted, branch → base, PRs as links with the checks glyphs from `plugins/github/PrPanel.tsx`'s table (copy the three-glyph mapping; don't import the github plugin), done lines, files with "also edited by 3f2a" badges; a stale stamp line when `Date.now() - liveAt > 600000`. CSS prefixed `sa-`; cards wrap, paths `overflow: hidden; text-overflow: ellipsis; min-width: 0`; check at 375 px.

- [ ] **Step 1: Write the failing test** for the helper (`glanceOrder(blocks)` returns working first, failed last; `staleLine(liveAt, now)` null/under/over).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** helper, component, `web.tsx`, CSS, manifest `web`. **Step 4: Run** → PASS; `pnpm typecheck && pnpm test`; `pnpm dev` and look at a two-session workspace's Details at desktop and 375 px. **Step 5: Commit** `git commit -m "session-awareness: Sessions at a glance Details section"`

### Task 10: Docs, the plugin table, ship

**Files:**
- Modify: `plugins/session-awareness/README.md` (full: what it does, the digest's lines and caps, triggers incl. the DB watch and the staleness stamp, routes, slots, settings table, the hook and how it is passed, `team.sh`, `wh claim`/`wh done`, caveats: keep-awake on keeps status fresh with no tab open, Windows untested, PreToolUse nudges need a Claude Code that honours `additionalContext` there)
- Modify: `CLAUDE.md` (plugin table row after `keep-awake`; in "Workspace model" add `wh claim`/`wh done` to the `bin/wh` bullet; in "Claude sessions" one line: sibling awareness is the session-awareness plugin)
- Modify: `docs/plugins.md` only if it lists `wh` commands (grep first)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Full check**: `pnpm typecheck && pnpm test && pnpm build`. Expected: all green.
- [ ] **Step 3: Commit** `git commit -m "session-awareness: README, CLAUDE.md row and notes"`
- [ ] **Step 4: Ship (work-hub rule: no review gate)**: `git -C ~/repos/work-hub pull --ff-only` (if its branch is main), merge `session-awareness` into `main` (`git -C ~/repos/work-hub merge --no-ff session-awareness`), push `main`, run `~/repos/work-hub/scripts/update.sh --no-pull`, then `bin/wh link add` is not needed (no PR); `bin/wh note work-hub "2026-11-06: session-awareness shipped (main @ <sha>)"`.
- [ ] **Step 5: Verify after deploy**: open a workspace with two sessions, confirm "Sessions at a glance" shows, run `bin/wh claim <ws> "smoke"` and see the card update within a few seconds.
