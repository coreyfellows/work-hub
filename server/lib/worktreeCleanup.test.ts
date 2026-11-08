import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectWorktree, openSessionsIn, removalBlock, removeWorktreeFolder } from './worktreeCleanup.ts';

const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' }).toString();

/** A repo with one commit on main and a linked worktree `root/wt` on branch `feat`. */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wtc-')));
  const repo = join(base, 'repo');
  const root = join(base, 'trees');
  mkdirSync(repo);
  mkdirSync(root);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'a');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  const wt = join(root, 'wt');
  g(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
  return { repo, root, wt };
}

test('openSessionsIn: cwd inside the worktree, not closed, not excepted', () => {
  const live = [
    { sessionId: 'a', name: 'A', cwd: '/w/x', status: 'idle' },
    { sessionId: 'b', name: 'B', cwd: '/w/x/sub', status: 'working' },
    { sessionId: 'c', name: 'C', cwd: '/w/x', status: 'done' },
    { sessionId: 'd', name: 'D', cwd: '/w/xy', status: 'idle' },
  ];
  assert.deepEqual(openSessionsIn('/w/x', live).map((s) => s.sessionId), ['a', 'b']);
  assert.deepEqual(openSessionsIn('/w/x', live, new Set(['a'])).map((s) => s.sessionId), ['b']);
});

test('a clean worktree with nothing unique is safe to remove, and gone afterwards', async () => {
  const { repo, root, wt } = fixture();
  const s = await inspectWorktree(wt);
  assert.deepEqual([s.exists, s.linked, s.dirty, s.unpushed], [true, true, false, 0]);
  assert.equal(removalBlock(s, root, false), null);
  await removeWorktreeFolder(s, false);
  assert.equal(existsSync(wt), false);
  assert.ok(!g(repo, 'worktree', 'list').includes(wt));
  assert.ok(g(repo, 'branch').includes('feat')); // the branch stays
});

test('uncommitted changes and untracked files block, unless forced', async () => {
  const { root, wt } = fixture();
  writeFileSync(join(wt, 'new.txt'), 'x');
  const s = await inspectWorktree(wt);
  assert.equal(s.dirty, true);
  assert.match(removalBlock(s, root, false)!, /uncommitted/);
  assert.equal(removalBlock(s, root, true), null);
  await removeWorktreeFolder(s, true);
  assert.equal(existsSync(wt), false);
});

test('an untracked node_modules alone does not block, and the worktree still goes', async () => {
  const { repo, root, wt } = fixture();
  mkdirSync(join(wt, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(wt, 'node_modules', 'x', 'i.js'), '1');
  mkdirSync(join(wt, 'pkg'));
  writeFileSync(join(wt, 'pkg', 'a.txt'), 'a');
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'pkg');
  g(repo, 'merge', '-q', '--ff-only', 'feat'); // main has it too, so nothing is unique to the worktree
  mkdirSync(join(wt, 'pkg', 'node_modules'), { recursive: true });
  writeFileSync(join(wt, 'pkg', 'node_modules', 'i.js'), '1');
  const s = await inspectWorktree(wt);
  assert.equal(s.dirty, false);
  assert.equal(removalBlock(s, root, false), null);
  await removeWorktreeFolder(s, false);
  assert.equal(existsSync(wt), false);
});

test('node_modules next to a real untracked file still blocks', async () => {
  const { root, wt } = fixture();
  mkdirSync(join(wt, 'node_modules'));
  writeFileSync(join(wt, 'node_modules', 'i.js'), '1');
  writeFileSync(join(wt, 'new.txt'), 'x');
  const s = await inspectWorktree(wt);
  assert.equal(s.dirty, true);
  assert.match(removalBlock(s, root, false)!, /uncommitted/);
});

test('commits no other branch has block; once merged into main they do not', async () => {
  const { repo, root, wt } = fixture();
  writeFileSync(join(wt, 'b.txt'), 'b');
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'work');
  let s = await inspectWorktree(wt);
  assert.equal(s.unpushed, 1);
  assert.match(removalBlock(s, root, false)!, /1 commit/);
  g(repo, 'merge', '-q', 'feat');
  s = await inspectWorktree(wt);
  assert.equal(s.unpushed, 0);
  assert.equal(removalBlock(s, root, false), null);
});

test("a repo's own checkout, and paths outside the root, are never removable", async () => {
  const { repo, root } = fixture();
  const main = await inspectWorktree(repo);
  assert.equal(main.linked, false);
  assert.match(removalBlock(main, root, true)!, /outside/);
  assert.match(removalBlock({ ...main, path: join(root, 'x') }, root, true)!, /not a linked/);
});

test('a worktree folder that is already gone only needs its record dropped', async () => {
  const { root, wt } = fixture();
  const s = { path: wt, exists: false, linked: false, dirty: false, unpushed: 0, gitCommonDir: null };
  assert.equal(removalBlock(s, root, false), null);
  await removeWorktreeFolder(s, false); // no throw
});
