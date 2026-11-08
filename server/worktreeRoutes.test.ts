import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { SourceControlProvider } from './lib/vcs/types.ts';

// A throwaway store and worktrees folder, set before anything reads config.
const tmp = mkdtempSync(join(tmpdir(), 'wh-wtr-'));
process.env.WORK_HUB_STATE_DIR = join(tmp, 'state');
process.env.TW_WORKTREES_ROOT = join(tmp, 'worktrees');
mkdirSync(process.env.TW_WORKTREES_ROOT, { recursive: true });
const { cleanupAfterClose, registerWorktreeRoutes } = await import('./worktreeRoutes.ts');
const { addWorktree, createWorkspace, getWorkspace } = await import('./store/workspaces.ts');
const { getProvider, registerProvider, removeProviders } = await import('./lib/vcs/registry.ts');
const { gitProvider } = await import('./lib/vcs/git.ts');
const { folderProvider } = await import('./lib/vcs/folder.ts');
if (!getProvider('git')) registerProvider(gitProvider);
if (!getProvider('folder')) registerProvider(folderProvider);

function app() {
  const a = new Hono();
  registerWorktreeRoutes(a, { liveSessions: () => [] });
  return a;
}
const list = async (a: Hono, ws: string) =>
  ((await (await a.request(`/api/workspaces/${ws}/worktrees`)).json()) as { worktrees: Array<Record<string, unknown>> }).worktrees;
const remove = async (a: Hono, ws: string, body: unknown) =>
  ((await (await a.request(`/api/workspaces/${ws}/worktrees/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as {
    results: Array<{ path: string; ok: boolean; reason?: string }>;
  }).results;

test('a plain folder is listed with its vcs, and removing it forgets the record but leaves the folder on disk', async () => {
  const dir = mkdtempSync(join(tmp, 'folder-'));
  const ws = createWorkspace({ title: 'F', origin: 'prompt' });
  addWorktree(ws, { path: dir, vcs: 'folder' });
  const a = app();
  const [info] = await list(a, ws);
  assert.equal(info.vcs, 'folder');
  assert.equal(info.exists, true);
  assert.equal(info.block, null);
  assert.equal(info.orphaned, true);
  assert.deepEqual(await remove(a, ws, { paths: [dir], force: true }), [{ path: dir, ok: true }]);
  assert.ok(existsSync(dir), 'the folder stays');
  assert.deepEqual(getWorkspace(ws)!.worktrees, []);
});

test('the bulk "remove orphaned" skips plain folders; they are only forgotten one at a time', async () => {
  const dir = mkdtempSync(join(tmp, 'bulk-folder-'));
  const ws = createWorkspace({ title: 'B', origin: 'prompt' });
  addWorktree(ws, { path: dir, vcs: 'folder' });
  const a = app();
  assert.deepEqual(await remove(a, ws, { orphaned: true }), []);
  assert.equal(getWorkspace(ws)!.worktrees.length, 1);
  assert.deepEqual(await remove(a, ws, { paths: [dir] }), [{ path: dir, ok: true }]);
  assert.ok(existsSync(dir));
  assert.deepEqual(getWorkspace(ws)!.worktrees, []);
});

test('a copy whose provider is not in force is never removable, not even forced', async () => {
  const dir = mkdtempSync(join(tmp, 'gone-'));
  const ws = createWorkspace({ title: 'X', origin: 'prompt' });
  addWorktree(ws, { path: dir, branch: 'feat', vcs: 'nope' });
  const a = app();
  const [info] = await list(a, ws);
  assert.equal(info.vcs, 'nope');
  assert.match(String(info.block), /nope/);
  const [r] = await remove(a, ws, { paths: [dir], force: true });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /nope/);
  assert.equal(getWorkspace(ws)!.worktrees.length, 1);
  assert.ok(existsSync(dir));
});

test("another provider's copy goes through its inspect and removeWorkingCopy", async () => {
  const calls: Array<{ root: string; force: boolean }> = [];
  let dirty = true;
  const fake: SourceControlProvider = {
    ...folderProvider,
    id: 'fakevcs',
    title: 'Fake',
    inspect: async () => ({ exists: true, dirty, unsaved: 2, removable: !dirty, block: dirty ? 'uncommitted changes' : null }),
    removeWorkingCopy: async (root, opts) => {
      calls.push({ root, force: opts.force });
    },
  };
  registerProvider(fake, 'fake-test');
  try {
    const dir = mkdtempSync(join(process.env.TW_WORKTREES_ROOT!, 'fake-'));
    const ws = createWorkspace({ title: 'P', origin: 'prompt' });
    addWorktree(ws, { path: dir, branch: 'feat', vcs: 'fakevcs' });
    const a = app();
    const [info] = await list(a, ws);
    assert.deepEqual([info.vcs, info.dirty, info.unpushed, info.block], ['fakevcs', true, 2, 'uncommitted changes']);
    assert.deepEqual(await remove(a, ws, { paths: [dir] }), [{ path: dir, ok: false, reason: 'uncommitted changes' }]);
    assert.equal(calls.length, 0);
    // The bulk "orphaned" removal skips it too (never forced).
    assert.deepEqual(await remove(a, ws, { orphaned: true }), []);
    assert.deepEqual(await remove(a, ws, { paths: [dir], force: true }), [{ path: dir, ok: true }]);
    assert.deepEqual(calls, [{ root: dir, force: true }]);
    assert.deepEqual(getWorkspace(ws)!.worktrees, []);
  } finally {
    removeProviders('fake-test');
  }
});

test("a copy whose provider can't inspect it is never removed, not even forced", async () => {
  let removed = false;
  const broken: SourceControlProvider = {
    ...folderProvider,
    id: 'brokenvcs',
    inspect: async () => {
      throw new Error('cli missing');
    },
    removeWorkingCopy: async () => {
      removed = true;
    },
  };
  registerProvider(broken, 'broken-test');
  try {
    const dir = mkdtempSync(join(process.env.TW_WORKTREES_ROOT!, 'broken-'));
    const ws = createWorkspace({ title: 'B', origin: 'prompt' });
    addWorktree(ws, { path: dir, vcs: 'brokenvcs' });
    const a = app();
    assert.equal((await list(a, ws))[0].block, "couldn't inspect it: cli missing");
    assert.deepEqual(await remove(a, ws, { paths: [dir], force: true }), [{ path: dir, ok: false, reason: "couldn't inspect it: cli missing" }]);
    assert.equal(removed, false);
    assert.equal(getWorkspace(ws)!.worktrees.length, 1);
  } finally {
    removeProviders('broken-test');
  }
});

test('another provider never removes a copy outside the worktrees folder, not even forced', async () => {
  const calls: string[] = [];
  const jj: SourceControlProvider = {
    ...folderProvider,
    id: 'jj',
    title: 'Fake jj',
    inspect: async () => ({ exists: true, dirty: false, unsaved: 0, removable: true, block: null }),
    removeWorkingCopy: async (root) => {
      calls.push(root);
    },
  };
  registerProvider(jj, 'jj-test');
  try {
    const dir = mkdtempSync(join(tmp, 'jj-outside-'));
    const ws = createWorkspace({ title: 'J', origin: 'prompt' });
    addWorktree(ws, { path: dir, branch: 'feat', vcs: 'jj' });
    const a = app();
    assert.equal((await list(a, ws))[0].block, 'outside the worktrees folder');
    assert.deepEqual(await remove(a, ws, { paths: [dir] }), [{ path: dir, ok: false, reason: 'outside the worktrees folder' }]);
    assert.deepEqual(await remove(a, ws, { paths: [dir], force: true }), [{ path: dir, ok: false, reason: 'outside the worktrees folder' }]);
    assert.deepEqual(await remove(a, ws, { orphaned: true }), []);
    assert.deepEqual(calls, []);
    assert.equal(getWorkspace(ws)!.worktrees.length, 1);
    assert.ok(existsSync(dir));
  } finally {
    removeProviders('jj-test');
  }
});

test('a git record outside the worktrees folder keeps the git path (blocked as before)', async () => {
  const dir = mkdtempSync(join(tmp, 'outside-'));
  const ws = createWorkspace({ title: 'G', origin: 'prompt' });
  addWorktree(ws, { repo: 'o/r', path: dir, branch: 'b', vcs: 'git' });
  const a = app();
  const [info] = await list(a, ws);
  assert.equal(info.vcs, 'git');
  assert.equal(info.block, 'outside the worktrees folder');
  const [r] = await remove(a, ws, { paths: [dir], force: true });
  assert.deepEqual(r, { path: dir, ok: false, reason: 'outside the worktrees folder' });
});

test('closing a session never touches non-git copies it worked in', async () => {
  const dir = mkdtempSync(join(process.env.TW_WORKTREES_ROOT!, 'plain-'));
  const ws = createWorkspace({ title: 'C', origin: 'prompt' });
  addWorktree(ws, { path: dir, vcs: 'folder' });
  const out = await cleanupAfterClose(ws, { sessionId: '00000000-0000-0000-0000-000000000000', cwd: dir }, []);
  assert.deepEqual(out, { removed: [], kept: [] });
  assert.equal(getWorkspace(ws)!.worktrees.length, 1);
  assert.ok(existsSync(dir));
});
