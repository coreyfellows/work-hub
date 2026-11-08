import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.WORK_HUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'wh-vcs-'));
const { migrate } = await import('./db.ts');
const { addWorktree, createWorkspace, deleteWorkspace, findWorkspaceByWorktree, getWorkspace, isTrustedFolder, trustFolder, allWorktrees, setWorkspaceVcs } =
  await import('./workspaces.ts');

test('a worktree recorded before the migration comes back as git with its repo and branch', () => {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  migrate(d, 16);
  d.prepare("INSERT INTO workspaces (id, title, origin) VALUES ('w', 'W', 'prompt')").run();
  d.prepare("INSERT INTO worktrees (workspace_id, repo, path, branch) VALUES ('w', 'o/r', '/p', 'b')").run();
  migrate(d);
  const row = d.prepare('SELECT * FROM worktrees').get() as Record<string, unknown>;
  assert.equal(row.vcs, 'git');
  assert.equal(row.repo, 'o/r');
  assert.equal(row.branch, 'b');
  assert.equal(row.path, '/p');
});

test('a folder worktree has no repo', () => {
  const ws = createWorkspace({ title: 'F', origin: 'prompt' });
  addWorktree(ws, { path: '/f', vcs: 'folder' });
  const w = getWorkspace(ws)!.worktrees[0];
  assert.equal(w.repo, null);
  assert.equal(w.vcs, 'folder');
  assert.equal(allWorktrees().find((x) => x.path === '/f')?.repo, null);
});

test('repo + branch lookup only matches git worktrees', () => {
  const jj = createWorkspace({ title: 'J', origin: 'prompt' });
  addWorktree(jj, { repo: 'o/r', path: '/jj', branch: 'x', vcs: 'jj' });
  assert.equal(findWorkspaceByWorktree({ repo: 'o/r', branch: 'x' }), null);
  const g = createWorkspace({ title: 'G', origin: 'prompt' });
  addWorktree(g, { repo: 'o/r', path: '/g', branch: 'x' });
  assert.equal(findWorkspaceByWorktree({ repo: 'o/r', branch: 'x' }), g);
  assert.equal(getWorkspace(g)!.worktrees[0].vcs, 'git');
});

test('a workspace has a vcs, null by default', () => {
  assert.equal(getWorkspace(createWorkspace({ title: 'N', origin: 'prompt' }))!.vcs, null);
  const id = createWorkspace({ title: 'P', origin: 'prompt', vcs: 'jj' });
  assert.equal(getWorkspace(id)!.vcs, 'jj');
  setWorkspaceVcs(id, 'git');
  assert.equal(getWorkspace(id)!.vcs, 'git');
});

test('trusted folders are remembered', () => {
  assert.equal(isTrustedFolder('/a'), false);
  trustFolder('/a');
  assert.equal(isTrustedFolder('/a'), true);
});

test('deleting a workspace takes its recorded worktrees with it', () => {
  const id = createWorkspace({ title: 'D', origin: 'prompt', vcs: 'folder' });
  addWorktree(id, { path: '/d-folder', vcs: 'folder' });
  deleteWorkspace(id);
  assert.equal(getWorkspace(id) ?? null, null);
  assert.equal(findWorkspaceByWorktree({ path: '/d-folder' }), null);
});
