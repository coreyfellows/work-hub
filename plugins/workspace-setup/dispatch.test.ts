import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServerPluginContext, SourceControlProvider, Workspace } from '../../plugin-api/server.ts';
import { dispatchWorkspace, explorerPrompt, explorerProvider, NeedsConfirm, needsExplorer, ticketWorkflowRules, type DispatchSettings } from './dispatch.ts';

const ws = (over: Partial<Workspace>): Workspace =>
  ({ id: 'ws-1', title: 'T', status: 'setting-up', sessions: [], worktrees: [], links: [], ticketKey: null, prompt: null, createdAt: new Date().toISOString(), ...over }) as Workspace;

test('only a fresh, empty, setting-up workspace needs its explorer started', () => {
  const now = Date.now();
  assert.equal(needsExplorer(ws({}), now), true);
  assert.equal(needsExplorer(ws({ status: 'active' }), now), false);
  assert.equal(needsExplorer(ws({ sessions: [{ claudeSessionId: 'a' } as Workspace['sessions'][number]] }), now), false);
  assert.equal(needsExplorer(ws({ createdAt: new Date(now - 20 * 60_000).toISOString() }), now), false);
});

const opts = { whCommand: '/hub/bin/wh', ticketWorkflowScripts: '/tw/scripts', fragment: '' };

test('a ticket explorer prompt names the ticket, its worktree layout, the wh commands and the epic step', () => {
  const p = explorerPrompt(ws({ ticketKey: 'TKT-123', prompt: 'extra ctx' }), opts);
  const lines = p.split('\n');
  assert.equal(lines[0], 'You\'re setting up the work-hub workspace "ws-1" for Jira ticket TKT-123, with this extra context from me:');
  assert.equal(lines[2], 'extra ctx');
  assert.ok(lines.includes('   - `git -C ~/repos/<repo> worktree add ~/worktrees/<repo>/<TKT-123> -b <branch> origin/<base>`'));
  assert.ok(p.includes('branch: `f-TKT-123-<short-desc>`'));
  assert.ok(lines.includes('   - then run `/tw/scripts/trust-worktree.sh <path>`.'));
  assert.ok(lines.includes('   - `/hub/bin/wh worktree add ws-1 --path <worktree> --base <base>` for each worktree'));
  assert.ok(p.includes('`/hub/bin/wh epic ws-1 <EPIC-KEY> "<epic title>"`'));
  assert.ok(p.includes('`/hub/bin/wh status ws-1 active`'));
  assert.equal(lines.at(-1), 'If something is ambiguous (which repo, which base branch), ask me rather than guessing.');
});

test("without the ticket-workflow scripts the explorer prompt's trust step is the core's `wh trust`", () => {
  const p = explorerPrompt(ws({ ticketKey: 'TKT-123' }), { ...opts, ticketWorkflowScripts: '' });
  assert.ok(!p.includes('trust-worktree'));
  assert.ok(p.split('\n').includes('   - then run `/hub/bin/wh trust <path>`.'));
  assert.ok(p.includes('Reuse an existing worktree'));
});

test('a prompt explorer prompt has no ticket steps; explorer fragments go last after a blank line', () => {
  const p = explorerPrompt(ws({ prompt: 'do a thing\nsecond line' }), { ...opts, fragment: 'FRAG' });
  assert.ok(p.startsWith('You\'re setting up the work-hub workspace "ws-1" for this task:\n\ndo a thing\nsecond line\n'));
  assert.ok(p.includes('1. Make sure you understand the task.'));
  assert.ok(p.includes('<short-kebab-desc>'));
  assert.ok(!p.includes(' epic '));
  assert.ok(p.endsWith('ask me rather than guessing.\n\nFRAG'));
});

test('the workspace-rules fragment carries the ticket-workflow conventions', () => {
  const t = ticketWorkflowRules({ ticketKey: 'TKT-1', worktreesDir: '/w', ticketWorkflowScripts: '/s', whCommand: '/hub/bin/wh' });
  assert.equal(
    t,
    'New worktrees follow the ticket-workflow conventions: `/w/<repo>/TKT-1`, branch `f-TKT-1-<short-desc>`, then run `/s/trust-worktree.sh <path>` on it.' +
      " Don't use `spawn-ticket-session`, cmux or other terminal workspaces, or `EnterWorktree`.",
  );
  const p = ticketWorkflowRules({ ticketKey: null, worktreesDir: '/w', ticketWorkflowScripts: '', whCommand: '/hub/bin/wh' });
  assert.ok(p.includes('`/w/<repo>/<short-kebab-desc>`, branch a short kebab-case description, then run `/hub/bin/wh trust <path>` on it.'));
  assert.ok(!p.includes('trust-worktree'));
});

test('a whCommand with a dir prefix is used as is in the explorer prompt, its trust step and the workspace rules', () => {
  const whCommand = "WORK_HUB_STATE_DIR='/x y' /hub/bin/wh";
  const p = explorerPrompt(ws({ ticketKey: 'TKT-123' }), { ...opts, whCommand, ticketWorkflowScripts: '' });
  assert.ok(p.includes(`\`${whCommand} status ws-1 active\``));
  assert.ok(p.split('\n').includes(`   - then run \`${whCommand} trust <path>\`.`));
  const r = ticketWorkflowRules({ ticketKey: null, worktreesDir: '/w', ticketWorkflowScripts: '', whCommand });
  assert.ok(r.includes(`then run \`${whCommand} trust <path>\``));
});

// --- Source control choice and plain folders -------------------------------------------------------------------------

const fakeJj = {
  id: 'jj',
  title: 'Jujutsu (jj)',
  agentInstructions: (o: { workspaceId: string; whCommand: string; worktreesDir: string }) => [
    `jj workspace add ${o.worktreesDir}/<repo>/<name>`,
    `then \`${o.whCommand} worktree add ${o.workspaceId} --path <dir> --vcs jj\``,
  ],
} as unknown as SourceControlProvider;

test("another provider's explorer prompt replaces only step 3 with its own instructions", () => {
  const w = ws({ ticketKey: 'TKT-123' });
  const git = explorerPrompt(w, opts).split('\n');
  const jj = explorerPrompt(w, { ...opts, provider: fakeJj, worktreesDir: '/w' }).split('\n');
  const step3 = (lines: string[]) => [lines.findIndex((l) => l.startsWith('3. ')), lines.findIndex((l) => l.startsWith('4. '))];
  const [g3, g4] = step3(git);
  const [j3, j4] = step3(jj);
  assert.deepEqual(jj.slice(j3, j4), [
    '3. Create its working copies with Jujutsu (jj):',
    '   - jj workspace add /w/<repo>/<name>',
    '   - then `/hub/bin/wh worktree add ws-1 --path <dir> --vcs jj`',
  ]);
  assert.deepEqual(jj.slice(0, j3), git.slice(0, g3));
  assert.deepEqual(jj.slice(j4), git.slice(g4));
});

test('the explorer gets no provider for no choice or git, and an unregistered choice fails', () => {
  const ctx = { vcs: { get: (id: string) => (id === 'jj' ? fakeJj : undefined) } } as unknown as ServerPluginContext;
  assert.equal(explorerProvider(ctx, null), undefined);
  assert.equal(explorerProvider(ctx, 'git'), undefined);
  assert.equal(explorerProvider(ctx, 'jj'), fakeJj);
  assert.throws(() => explorerProvider(ctx, 'hg'), { message: "hg isn't available (switch its plugin on in Settings → Plugins)" });
});

/** A fake plugin context over an in-memory workspace list; records what dispatch did. */
function fakeCtx(paths: { plainDir: string; worktreesDir: string; reposDir?: string }, vcsDefault: string | null = null, opts: { failStart?: boolean } = {}) {
  const log = { started: [] as Array<{ cwd: string; purpose?: string; prompt: string }>, trusted: [] as string[], trustedFolders: new Set<string>(), sessions: [] as Array<{ role: string; cwd: string }> };
  const wss = new Map<string, Workspace>();
  const store = {
    suggestId: (i: { title: string }) => i.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    uniqueId: (base: string) => (wss.has(base) ? `${base}-2` : base),
    createWorkspace: (i: Partial<Workspace>) => {
      const id = i.id ?? `ws-${wss.size + 1}`;
      wss.set(id, ws({ id, title: i.title, status: i.status, ticketKey: i.ticketKey ?? null, prompt: i.prompt ?? null, vcs: i.vcs ?? null, worktrees: [], sessions: [] } as Partial<Workspace>));
      return id;
    },
    getWorkspace: (id: string) => wss.get(id),
    deleteWorkspace: (id: string) => void wss.delete(id),
    addLink: () => {},
    addWorktree: (id: string, w: { path: string; vcs: string; repo: null }) => wss.get(id)!.worktrees.push(w as unknown as Workspace['worktrees'][number]),
    addSession: (id: string, s: { role: string; cwd: string }) => {
      wss.get(id)!.sessions.push(s as unknown as Workspace['sessions'][number]);
      log.sessions.push(s);
    },
    logEvent: () => {},
    trustFolder: (p: string) => void log.trustedFolders.add(p),
    isTrustedFolder: (p: string) => log.trustedFolders.has(p),
  };
  const ctx = {
    store,
    paths: { reposDir: '/nonexistent-repos', ...paths, whCommand: '/hub/bin/wh' },
    vcs: { get: (id: string) => (id === 'jj' ? fakeJj : id === 'folder' ? { id: 'folder', title: 'Plain folder' } : id === 'git' ? { id: 'git', title: 'Git' } : undefined), effectiveDefault: () => vcsDefault },
    prompts: { fragments: () => '', workspaceContext: async (w: Workspace, task: string) => `CONTEXT ${w.id}\n${task}` },
    sessions: {
      trustWorktree: async (p: string) => {
        log.trusted.push(p);
        return { path: p, changed: true };
      },
      startBackground: async (o: { cwd: string; purpose?: string; prompt: string }) => {
        if (opts.failStart) throw new Error('claude --bg failed');
        log.started.push(o);
        return { shortId: 'abc', sessionId: `sess-${log.started.length}`, output: '' };
      },
    },
  } as unknown as ServerPluginContext;
  const settings: DispatchSettings = { ctx, explorerModel: 'opus', jiraBaseUrl: '', whCommand: '/hub/bin/wh', ticketWorkflowScripts: '' };
  return { settings, log, wss };
}

/** A scratch folder inside the checkout (inside the home folder): tmpdir is /private/var, a refused system folder. */
async function scratch(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await realpath(await mkdtemp(join(process.cwd(), '.wh-dispatch-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const plainDir = join(base, 'plain');
  const worktreesDir = join(base, 'worktrees');
  await mkdir(plainDir);
  await mkdir(worktreesDir);
  return { base, plainDir, worktreesDir };
}

test('a folder name makes <plain>/<name>, records it as a folder and starts one main session there (no explorer)', async (t) => {
  const { plainDir, worktreesDir } = await scratch(t);
  const { settings, log } = fakeCtx({ plainDir, worktreesDir });
  const w = await dispatchWorkspace(settings, { folder: 'notes' });
  const dir = join(plainDir, 'notes');
  assert.equal((await stat(dir)).isDirectory(), true);
  assert.equal(w.vcs, 'folder');
  assert.equal(w.status, 'active');
  assert.equal(w.title, 'notes');
  assert.deepEqual(
    w.worktrees.map((x) => [x.path, x.vcs]),
    [[dir, 'folder']],
  );
  assert.deepEqual(log.trusted, [dir]);
  assert.equal(log.trustedFolders.size, 0, 'inside the plain root: nothing to confirm or store');
  assert.equal(log.started.length, 1);
  assert.equal(log.started[0].cwd, dir);
  assert.notEqual(log.started[0].purpose, 'explorer');
  assert.equal(log.started[0].prompt, `CONTEXT ${w.id}\nGet oriented in this folder and wait for me.`);
  assert.deepEqual(log.sessions, [{ claudeSessionId: 'sess-1', role: 'main', name: 'notes', cwd: dir }]);
});

test('with a folder, the prompt is kept on the workspace (not repeated as the task) and a ticket is kept', async (t) => {
  const { plainDir, worktreesDir } = await scratch(t);
  const { settings, log } = fakeCtx({ plainDir, worktreesDir });
  const w = await dispatchWorkspace(settings, { folder: 'docs', ticket: 'tkt-9', prompt: 'Tidy the docs' });
  assert.equal(w.ticketKey, 'TKT-9');
  assert.equal(w.title, 'TKT-9');
  assert.equal(w.prompt, 'Tidy the docs');
  assert.equal(log.started[0].prompt, `CONTEXT ${w.id}\nStart on the original request above.`);
});

test('a file where the folder would go is an error, and nothing is started', async (t) => {
  const { plainDir, worktreesDir } = await scratch(t);
  await writeFile(join(plainDir, 'afile'), 'x');
  const { settings, log, wss } = fakeCtx({ plainDir, worktreesDir });
  await assert.rejects(dispatchWorkspace(settings, { folder: 'afile' }), { message: `${join(plainDir, 'afile')} is a file` });
  assert.equal(log.started.length, 0);
  assert.equal(wss.size, 0);
});

test('a folder outside both roots needs a confirmation first; confirmed, it is trusted and stored', async (t) => {
  const { base, plainDir, worktreesDir } = await scratch(t);
  const outside = join(base, 'elsewhere', 'proj');
  const { settings, log, wss } = fakeCtx({ plainDir, worktreesDir });
  await assert.rejects(dispatchWorkspace(settings, { folder: outside }), (e) => e instanceof NeedsConfirm && e.path === outside);
  assert.equal(wss.size, 0);
  await assert.rejects(stat(outside));
  const w = await dispatchWorkspace(settings, { folder: outside, confirmFolder: true });
  assert.deepEqual([...log.trustedFolders], [outside]);
  assert.deepEqual(log.trusted, [outside]);
  assert.equal(w.worktrees[0].path, outside);
  // Already confirmed: no second question.
  const again = await dispatchWorkspace(settings, { folder: outside });
  assert.equal(again.worktrees[0].path, outside);
});

test('a folder that can never be trusted is refused, confirmed or not', async (t) => {
  const { plainDir, worktreesDir } = await scratch(t);
  const { settings } = fakeCtx({ plainDir, worktreesDir });
  await assert.rejects(dispatchWorkspace(settings, { folder: '/etc/x', confirmFolder: true }), { message: '/etc/x is a system folder' });
  await assert.rejects(dispatchWorkspace(settings, { folder: '~', confirmFolder: true }), /home folder/);
});

test('the worktrees, repos and plain roots (or a folder containing one) are refused, not offered for confirmation', async (t) => {
  const { base, plainDir, worktreesDir } = await scratch(t);
  const reposDir = join(base, 'repos');
  await mkdir(reposDir);
  const { settings, log, wss } = fakeCtx({ plainDir, worktreesDir, reposDir });
  for (const [folder, name] of [[worktreesDir, 'worktrees'], [reposDir, 'repos'], [plainDir, 'plain workspaces'], [base, 'worktrees']] as const) {
    await assert.rejects(dispatchWorkspace(settings, { folder, confirmFolder: true }), { message: `${folder} is (or contains) the ${name} folder: pick a folder inside it` });
    await assert.rejects(dispatchWorkspace(settings, { folder }), (e) => !(e instanceof NeedsConfirm));
  }
  assert.equal(wss.size, 0);
  assert.equal(log.trustedFolders.size, 0);
  assert.equal(log.started.length, 0);
});

test('a chosen provider is stored and checked; Detect stores the Settings default unless it is git', async (t) => {
  const { plainDir, worktreesDir } = await scratch(t);
  const a = fakeCtx({ plainDir, worktreesDir });
  const w = await dispatchWorkspace(a.settings, { prompt: 'x', vcs: 'jj' });
  assert.equal(w.vcs, 'jj');
  assert.equal(w.status, 'setting-up');
  assert.equal(a.log.started[0].purpose, 'explorer');
  assert.ok(a.log.started[0].prompt.includes('3. Create its working copies with Jujutsu (jj):'));
  await assert.rejects(dispatchWorkspace(a.settings, { prompt: 'x', vcs: 'hg' }), { message: "hg isn't available (switch its plugin on in Settings → Plugins)" });
  await assert.rejects(dispatchWorkspace(a.settings, { prompt: 'x', vcs: 'folder' }), /needs a Folder/);
  await assert.rejects(dispatchWorkspace(a.settings, { folder: 'n', vcs: 'jj' }), /no source control/);

  const detect = await dispatchWorkspace(a.settings, { prompt: 'x', vcs: 'detect' });
  assert.equal(detect.vcs, null);
  assert.ok(a.log.started.at(-1)!.prompt.includes('3. For each repo, create a worktree'));
  for (const [dflt, want] of [['jj', 'jj'], ['git', null], [null, null]] as const) {
    const b = fakeCtx({ plainDir, worktreesDir }, dflt);
    assert.equal((await dispatchWorkspace(b.settings, { prompt: 'x' })).vcs, want, `default ${dflt}`);
  }
});

test('the workspace-rules fragment is left out when the workspace has no git', () => {
  const o = { ticketKey: 'TKT-1', worktreesDir: '/w', ticketWorkflowScripts: '/s', whCommand: '/hub/bin/wh' };
  const full = ticketWorkflowRules(o);
  assert.equal(ticketWorkflowRules({ ...o, kinds: ['git'] }), full);
  assert.equal(ticketWorkflowRules({ ...o, kinds: ['git', 'folder'] }), full);
  assert.equal(ticketWorkflowRules({ ...o, kinds: ['folder'] }), '');
  assert.equal(ticketWorkflowRules({ ...o, kinds: ['jj'] }), '');
});

test('a Settings default of Plain folder (on Detect, no Folder) makes <plain>/<workspace id> with a main session, no explorer', async (t) => {
  const { plainDir, worktreesDir } = await scratch(t);
  const { settings, log } = fakeCtx({ plainDir, worktreesDir }, 'folder');
  const w = await dispatchWorkspace(settings, { prompt: 'Write the report' });
  assert.equal(w.id, 'write-the-report');
  const dir = join(plainDir, w.id);
  assert.equal((await stat(dir)).isDirectory(), true);
  assert.equal(w.vcs, 'folder');
  assert.equal(w.status, 'active');
  assert.deepEqual(
    w.worktrees.map((x) => [x.path, x.vcs]),
    [[dir, 'folder']],
  );
  assert.equal(log.started.length, 1);
  assert.equal(log.started[0].cwd, dir);
  assert.equal(log.started[0].purpose, 'new-session');
  assert.equal(log.started[0].prompt, `CONTEXT ${w.id}\nStart on the original request above.`);
  assert.deepEqual(
    log.sessions.map((x) => x.role),
    ['main'],
  );
});

// Golden: the git explorer prompt, pasted from the code before source-control providers (d0551fd). It must not change.
const GOLDEN: Array<[string, Partial<Workspace>, string, string]> = [
  [
    "ticket, scripts",
    { ticketKey: 'TKT-123', prompt: 'extra ctx' },
    '/tw/scripts',
    [
      "You're setting up the work-hub workspace \"ws-1\" for Jira ticket TKT-123, with this extra context from me:",
      "",
      "extra ctx",
      "",
      "This session is setup and reconnaissance only. Don't implement anything yet.",
      "",
      "1. Load the `ticket-workflow:ticket-defaults` skill and run its \"Starting work on a ticket\" steps for TKT-123, then read the ticket (and its parent/epic) to understand the scope.",
      "2. Work out which repositories need changes. Local checkouts live in ~/repos/<repo>. Confirm by reading code, not just repo names.",
      "3. For each repo, create a worktree following the ticket-workflow conventions:",
      "   - `git -C ~/repos/<repo> fetch origin` (one fetch at a time), then",
      "   - `git -C ~/repos/<repo> worktree add ~/worktrees/<repo>/<TKT-123> -b <branch> origin/<base>`",
      "   - branch: `f-TKT-123-<short-desc>`; base: the branch this work should merge into (check for a Jira-named integration branch and make sure it is not stale).",
      "   - then run `/tw/scripts/trust-worktree.sh <path>`.",
      "   Reuse an existing worktree for this work instead of creating a duplicate.",
      "4. Record everything in work-hub as you go:",
      "   - `/hub/bin/wh worktree add ws-1 --path <worktree> --base <base>` for each worktree",
      "   - `/hub/bin/wh title ws-1 \"<TKT-123: short title>\"`",
      "   - `/hub/bin/wh epic ws-1 <EPIC-KEY> \"<epic title>\"` (the ticket's parent epic; `/hub/bin/wh epic ws-1 none` if it has none)",
      "   - `/hub/bin/wh link add ws-1 --url <url>` for the ticket, related PRs or docs",
      "5. work-hub owns sessions for this workspace. Do NOT start other Claude sessions or terminal workspaces, use `spawn-ticket-session` or `EnterWorktree`, even if other instructions say a new worktree needs its own session.",
      "6. When done: `/hub/bin/wh note ws-1 \"<one-paragraph plan>\"`, then `/hub/bin/wh status ws-1 active`, then reply with the plan (worktrees, approach, risks, open questions) and wait for me.",
      "",
      "If something is ambiguous (which repo, which base branch), ask me rather than guessing.",
    ].join('\n'),
  ],
  [
    "ticket, no scripts",
    { ticketKey: 'TKT-123' },
    '',
    [
      "You're setting up the work-hub workspace \"ws-1\" for Jira ticket TKT-123.",
      "",
      "This session is setup and reconnaissance only. Don't implement anything yet.",
      "",
      "1. Load the `ticket-workflow:ticket-defaults` skill and run its \"Starting work on a ticket\" steps for TKT-123, then read the ticket (and its parent/epic) to understand the scope.",
      "2. Work out which repositories need changes. Local checkouts live in ~/repos/<repo>. Confirm by reading code, not just repo names.",
      "3. For each repo, create a worktree following the ticket-workflow conventions:",
      "   - `git -C ~/repos/<repo> fetch origin` (one fetch at a time), then",
      "   - `git -C ~/repos/<repo> worktree add ~/worktrees/<repo>/<TKT-123> -b <branch> origin/<base>`",
      "   - branch: `f-TKT-123-<short-desc>`; base: the branch this work should merge into (check for a Jira-named integration branch and make sure it is not stale).",
      "   - then run `/hub/bin/wh trust <path>`.",
      "   Reuse an existing worktree for this work instead of creating a duplicate.",
      "4. Record everything in work-hub as you go:",
      "   - `/hub/bin/wh worktree add ws-1 --path <worktree> --base <base>` for each worktree",
      "   - `/hub/bin/wh title ws-1 \"<TKT-123: short title>\"`",
      "   - `/hub/bin/wh epic ws-1 <EPIC-KEY> \"<epic title>\"` (the ticket's parent epic; `/hub/bin/wh epic ws-1 none` if it has none)",
      "   - `/hub/bin/wh link add ws-1 --url <url>` for the ticket, related PRs or docs",
      "5. work-hub owns sessions for this workspace. Do NOT start other Claude sessions or terminal workspaces, use `spawn-ticket-session` or `EnterWorktree`, even if other instructions say a new worktree needs its own session.",
      "6. When done: `/hub/bin/wh note ws-1 \"<one-paragraph plan>\"`, then `/hub/bin/wh status ws-1 active`, then reply with the plan (worktrees, approach, risks, open questions) and wait for me.",
      "",
      "If something is ambiguous (which repo, which base branch), ask me rather than guessing.",
    ].join('\n'),
  ],
  [
    "prompt, scripts",
    { prompt: 'do a thing\nsecond line' },
    '/tw/scripts',
    [
      "You're setting up the work-hub workspace \"ws-1\" for this task:",
      "",
      "do a thing",
      "second line",
      "",
      "This session is setup and reconnaissance only. Don't implement anything yet.",
      "",
      "1. Make sure you understand the task. If it is too vague to pick repos, ask me.",
      "2. Work out which repositories need changes. Local checkouts live in ~/repos/<repo>. Confirm by reading code, not just repo names.",
      "3. For each repo, create a worktree following the ticket-workflow conventions:",
      "   - `git -C ~/repos/<repo> fetch origin` (one fetch at a time), then",
      "   - `git -C ~/repos/<repo> worktree add ~/worktrees/<repo>/<short-kebab-desc> -b <branch> origin/<base>`",
      "   - branch: a short kebab-case description; base: the branch this work should merge into (check for a Jira-named integration branch and make sure it is not stale).",
      "   - then run `/tw/scripts/trust-worktree.sh <path>`.",
      "   Reuse an existing worktree for this work instead of creating a duplicate.",
      "4. Record everything in work-hub as you go:",
      "   - `/hub/bin/wh worktree add ws-1 --path <worktree> --base <base>` for each worktree",
      "   - `/hub/bin/wh title ws-1 \"<Short: short title>\"`",
      "   - `/hub/bin/wh link add ws-1 --url <url>` for the ticket, related PRs or docs",
      "5. work-hub owns sessions for this workspace. Do NOT start other Claude sessions or terminal workspaces, use `spawn-ticket-session` or `EnterWorktree`, even if other instructions say a new worktree needs its own session.",
      "6. When done: `/hub/bin/wh note ws-1 \"<one-paragraph plan>\"`, then `/hub/bin/wh status ws-1 active`, then reply with the plan (worktrees, approach, risks, open questions) and wait for me.",
      "",
      "If something is ambiguous (which repo, which base branch), ask me rather than guessing.",
    ].join('\n'),
  ],
  [
    "prompt, no scripts",
    { prompt: 'do a thing\nsecond line' },
    '',
    [
      "You're setting up the work-hub workspace \"ws-1\" for this task:",
      "",
      "do a thing",
      "second line",
      "",
      "This session is setup and reconnaissance only. Don't implement anything yet.",
      "",
      "1. Make sure you understand the task. If it is too vague to pick repos, ask me.",
      "2. Work out which repositories need changes. Local checkouts live in ~/repos/<repo>. Confirm by reading code, not just repo names.",
      "3. For each repo, create a worktree following the ticket-workflow conventions:",
      "   - `git -C ~/repos/<repo> fetch origin` (one fetch at a time), then",
      "   - `git -C ~/repos/<repo> worktree add ~/worktrees/<repo>/<short-kebab-desc> -b <branch> origin/<base>`",
      "   - branch: a short kebab-case description; base: the branch this work should merge into (check for a Jira-named integration branch and make sure it is not stale).",
      "   - then run `/hub/bin/wh trust <path>`.",
      "   Reuse an existing worktree for this work instead of creating a duplicate.",
      "4. Record everything in work-hub as you go:",
      "   - `/hub/bin/wh worktree add ws-1 --path <worktree> --base <base>` for each worktree",
      "   - `/hub/bin/wh title ws-1 \"<Short: short title>\"`",
      "   - `/hub/bin/wh link add ws-1 --url <url>` for the ticket, related PRs or docs",
      "5. work-hub owns sessions for this workspace. Do NOT start other Claude sessions or terminal workspaces, use `spawn-ticket-session` or `EnterWorktree`, even if other instructions say a new worktree needs its own session.",
      "6. When done: `/hub/bin/wh note ws-1 \"<one-paragraph plan>\"`, then `/hub/bin/wh status ws-1 active`, then reply with the plan (worktrees, approach, risks, open questions) and wait for me.",
      "",
      "If something is ambiguous (which repo, which base branch), ask me rather than guessing.",
    ].join('\n'),
  ],
];

for (const [name, over, scripts, want] of GOLDEN) {
  test(`the git explorer prompt is byte-identical to before (${name}; vcs null and git)`, () => {
    for (const vcs of [null, 'git']) assert.equal(explorerPrompt(ws({ ...over, vcs }), { ...opts, ticketWorkflowScripts: scripts }), want);
  });
}

test("an explicit git choice starts the same explorer prompt as Detect", async (t) => {
  const { plainDir, worktreesDir } = await scratch(t);
  const a = fakeCtx({ plainDir, worktreesDir });
  const b = fakeCtx({ plainDir, worktreesDir });
  const detect = await dispatchWorkspace(a.settings, { ticket: 'TKT-5', prompt: 'ctx' });
  const git = await dispatchWorkspace(b.settings, { ticket: 'TKT-5', prompt: 'ctx', vcs: 'git' });
  assert.equal(detect.vcs, null);
  assert.equal(git.vcs, 'git');
  assert.equal(b.log.started[0].prompt, a.log.started[0].prompt);
});

test('a symlink inside the plain root that leads outside it needs a confirmation', async (t) => {
  const { base, plainDir, worktreesDir } = await scratch(t);
  const target = join(base, 'outside');
  await mkdir(target);
  await symlink(target, join(plainDir, 'link'));
  const { settings, log, wss } = fakeCtx({ plainDir, worktreesDir });
  await assert.rejects(dispatchWorkspace(settings, { folder: 'link' }), (e) => e instanceof NeedsConfirm && e.path === join(plainDir, 'link'));
  assert.equal(wss.size, 0);
  const w = await dispatchWorkspace(settings, { folder: 'link', confirmFolder: true });
  assert.deepEqual([...log.trustedFolders], [target]);
  assert.equal(w.worktrees[0].path, target);
});

test('a folder workspace whose session fails to start is removed again, and the error comes back', async (t) => {
  const { plainDir, worktreesDir } = await scratch(t);
  const { settings, wss } = fakeCtx({ plainDir, worktreesDir }, null, { failStart: true });
  await assert.rejects(dispatchWorkspace(settings, { folder: 'notes' }), { message: 'claude --bg failed' });
  assert.equal(wss.size, 0);
  assert.equal((await stat(join(plainDir, 'notes'))).isDirectory(), true, 'the folder itself stays');
});
