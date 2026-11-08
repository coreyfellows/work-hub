import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Workspace } from './store/workspaces.ts';

// workspaceRules looks the workspace up, so the store gets a throwaway state dir (set before anything reads config).
process.env.WORK_HUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'wh-wss-'));
const { contextPrompt, workspaceRules } = await import('./workspaceSessions.ts');
const { config } = await import('./config.ts');
const { addWorktree, createWorkspace, setWorkspaceVcs } = await import('./store/workspaces.ts');
const { addFragment, removeFragments } = await import('./lib/prompts.ts');
const { registerProvider, getProvider } = await import('./lib/vcs/registry.ts');
const { gitProvider } = await import('./lib/vcs/git.ts');
const { folderProvider } = await import('./lib/vcs/folder.ts');
if (!getProvider('git')) registerProvider(gitProvider);
if (!getProvider('folder')) registerProvider(folderProvider);

// The workspace context a new or review session starts with (ctx.prompts.workspaceContext), byte for byte as before
// session-tools moved out (but for the app's old name → "work-hub"); the rules part is whatever workspaceRules says (it names this checkout's `wh`).
const rules = (id: string) => workspaceRules(id).join('\n');

test('the workspace context prompt, everything filled in', async () => {
  const ws = {
    id: 'ws-1', title: 'Fix the thing', status: 'active', ticketKey: 'ABC-123', epicKey: 'ABC-1', epicTitle: 'The epic',
    prompt: 'Make it work\nacross two lines', notes: 'Plan:\n- step one\n- step two',
    worktrees: [{ id: 1, path: '/w/repo/ABC-123', repo: 'org/repo', branch: 'f-ABC-123-x', baseBranch: 'main' }, { id: 2, path: '/w/other', repo: 'org/other', branch: null, baseBranch: null }],
    links: [{ kind: 'jira', url: 'https://jira/ABC-123', label: null }, { kind: 'pr', url: 'https://gh/pr/1', label: 'PR' }],
    sessions: [{ claudeSessionId: 'nope-1', shortId: 'aaaa1111', name: 'first', role: 'main' }, { claudeSessionId: 'nope-2', shortId: 'bbbb2222', name: null, role: 'explorer' }],
  } as unknown as Workspace;
  assert.equal(await contextPrompt(ws, 'Do the task'), `You're working in the work-hub workspace "ws-1" (Fix the thing). What it's about:

- Ticket: ABC-123 (https://jira/ABC-123)
- Epic: ABC-1 (The epic)
- Original request:
  Make it work
  across two lines
- Plan and notes:
  Plan:
  - step one
  - step two
- Worktrees:
  - /w/repo/ABC-123 (org/repo @f-ABC-123-x → main)
  - /w/other (org/other @?)
- Links:
  - https://jira/ABC-123
  - PR: https://gh/pr/1
- Earlier sessions in this workspace (JSONL transcripts can be large: grep them, don't read them whole):
  - aaaa1111 "first"
  - bbbb2222 "explorer"

${rules(ws.id)}

Your task:

Do the task`);
});

test('the workspace context prompt, a bare workspace', async () => {
  const ws = { id: 'bare', title: 'Bare', status: 'active', ticketKey: null, epicKey: null, epicTitle: null, prompt: null, notes: null, worktrees: [], links: [], sessions: [] } as unknown as Workspace;
  assert.equal(await contextPrompt(ws, 'T'), `You're working in the work-hub workspace "bare" (Bare). What it's about:

- Worktrees: none recorded yet.

${rules(ws.id)}

Your task:

T`);
});

// Today's rules, copied as they read before source-control providers: a git-only (or empty) workspace gets exactly these.
const WH = config.whCommand;
const gitRules = (id: string) => [
  "work-hub owns the sessions for this workspace. If part of the work needs its own session (e.g. a separate PR), you may start one: create the worktree (`git worktree add`), record it with `wh worktree add`, and run plain `claude --bg --name \"<name>\" --model <model> \"<self-contained prompt>\"` from inside it; work-hub adds it to this workspace by itself.",
  `Record what you create with \`${WH}\`: \`worktree add ${id} --path <path> --base <base>\`, \`link add ${id} --url <url>\` (every PR you open), \`note ${id} "<plan>"\`.`,
];

test('workspaceRules: a git-only, an empty and an unknown workspace read exactly as before', () => {
  const git = createWorkspace({ title: 'G', origin: 'prompt' });
  addWorktree(git, { repo: 'org/repo', path: '/w/repo/G', branch: 'f-g', vcs: 'git' });
  assert.deepEqual(workspaceRules(git), gitRules(git));
  const empty = createWorkspace({ title: 'E', origin: 'prompt' });
  assert.deepEqual(workspaceRules(empty), gitRules(empty));
  assert.deepEqual(workspaceRules('ws'), gitRules('ws'));
});

test('workspaceRules: a folder copy (or a folder choice) appends the folder provider\'s instructions', () => {
  const opts = (id: string) => ({ workspaceId: id, ticketKey: null, whCommand: WH, worktreesDir: config.paths.worktrees });
  const mixed = createWorkspace({ title: 'M', origin: 'prompt' });
  addWorktree(mixed, { repo: 'org/repo', path: '/w/repo/M', branch: 'f-m', vcs: 'git' });
  addWorktree(mixed, { path: '/p/notes', vcs: 'folder' });
  assert.deepEqual(workspaceRules(mixed), [...gitRules(mixed), ...folderProvider.agentInstructions(opts(mixed))]);
  const chosen = createWorkspace({ title: 'C', origin: 'prompt' });
  setWorkspaceVcs(chosen, 'folder');
  assert.deepEqual(workspaceRules(chosen).at(-1), folderProvider.agentInstructions(opts(chosen)).at(-1));
  // A kind with no provider in force (its plugin is off) adds nothing.
  const gone = createWorkspace({ title: 'X', origin: 'prompt' });
  addWorktree(gone, { path: '/p/jj', branch: 'feat', vcs: 'nope' });
  assert.deepEqual(workspaceRules(gone), gitRules(gone));
});

test('workspace-rules and session-context fragments get the workspace\'s kinds', async () => {
  const seen: Array<{ kind: string; kinds: unknown }> = [];
  addFragment('workspace-rules', (c) => (seen.push({ kind: 'rules', kinds: c.kinds }), null), 'kinds-test');
  addFragment('session-context', (c) => (seen.push({ kind: 'context', kinds: c.kinds }), null), 'kinds-test');
  try {
    const id = createWorkspace({ title: 'K', origin: 'prompt' });
    setWorkspaceVcs(id, 'jj');
    addWorktree(id, { path: '/p/a', vcs: 'folder' });
    addWorktree(id, { repo: 'o/r', path: '/w/r/K', branch: 'b', vcs: 'git' });
    addWorktree(id, { path: '/p/b', vcs: 'folder' });
    workspaceRules(id);
    assert.deepEqual(seen.pop(), { kind: 'rules', kinds: ['jj', 'folder', 'git'] });
    workspaceRules('no-such-workspace');
    assert.deepEqual(seen.pop(), { kind: 'rules', kinds: ['git'] });
    const ws = { id: 'k', title: 'K', status: 'active', vcs: null, ticketKey: null, epicKey: null, epicTitle: null, prompt: null, notes: null, worktrees: [{ id: 1, vcs: 'folder', path: '/p', repo: null, branch: null, baseBranch: null }], links: [], sessions: [] } as unknown as Workspace;
    seen.length = 0;
    await contextPrompt(ws, 'T');
    assert.deepEqual(seen, [{ kind: 'context', kinds: ['folder'] }, { kind: 'rules', kinds: ['folder'] }]);
  } finally {
    removeFragments('kinds-test');
  }
});

test('the workspace context prompt lists a folder as (folder), another kind by its line, git as before', async () => {
  const ws = {
    id: 'mix', title: 'Mix', status: 'active', vcs: null, ticketKey: null, epicKey: null, epicTitle: null, prompt: null, notes: null,
    worktrees: [
      { id: 1, vcs: 'git', path: '/w/repo/X', repo: 'org/repo', branch: 'f-x', baseBranch: 'main' },
      { id: 2, vcs: 'folder', path: '/p', repo: null, branch: null, baseBranch: null },
      { id: 3, vcs: 'jj', path: '/j', repo: null, branch: 'feat', baseBranch: 'trunk' },
      { id: 4, vcs: 'hg', path: '/h', repo: 'org/h', branch: null, baseBranch: null },
    ],
    links: [], sessions: [],
  } as unknown as Workspace;
  const out = await contextPrompt(ws, 'T');
  assert.ok(out.includes(`- Worktrees:
  - /w/repo/X (org/repo @f-x → main)
  - /p (folder)
  - /j (jj @feat → trunk)
  - /h (hg org/h @?)
`), out);
});
