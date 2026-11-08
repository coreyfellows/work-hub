import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkFolder, expandFolder, folderError, folderTrustError, foldersGroup } from './folders.ts';

test('expandFolder: ~ and trailing slashes', () => {
  assert.equal(expandFolder('~/code/', '/h'), '/h/code');
  assert.equal(expandFolder('~', '/h'), '/h');
  assert.equal(expandFolder(' /a/b// ', '/h'), '/a/b');
  assert.equal(expandFolder('/', '/h'), '/');
});

test('folderError: absolute, not the root', () => {
  assert.equal(folderError('~/repos', '/h'), null);
  assert.equal(folderError('/srv/code', '/h'), null);
  assert.match(folderError('code', '/h')!, /absolute/);
  assert.match(folderError('/', '/h')!, /root/);
  assert.match(folderError('  ', '/h')!, /required/);
  assert.match(folderError(5, '/h')!, /required/);
});

test('checkFolder: repos must exist, worktrees are created, a file is refused', async () => {
  const base = await mkdtemp(join(tmpdir(), 'folders-'));
  assert.match((await checkFolder(join(base, 'repos'), { create: false })).error!, /doesn't exist/);
  const made = await checkFolder(join(base, 'trees', 'deep'), { create: true });
  assert.equal(made.path, join(base, 'trees', 'deep'));
  assert.equal((await checkFolder(made.path, { create: false })).error, undefined);
  await writeFile(join(base, 'f'), 'x');
  assert.match((await checkFolder(join(base, 'f'), { create: true })).error!, /is a file/);
});

test('the group has the env names the app already used', () => {
  const g = foldersGroup('/h');
  assert.deepEqual(g.defs.slice(0, 2).map((d) => [d.key, d.env, d.default]), [
    ['reposDir', 'WORK_HUB_REPOS_DIR', '/h/repos'],
    ['worktreesDir', 'TW_WORKTREES_ROOT', '/h/worktrees'],
  ]);
  assert.equal(g.defs.find((d) => d.key === 'cleanupOnClose')?.default, true);
});

test('the plain workspaces folder: ~/workspaces by default, WORK_HUB_PLAIN_DIR', () => {
  const d = foldersGroup('/h').defs.find((x) => x.key === 'plainDir');
  assert.deepEqual([d?.default, d?.env], ['/h/workspaces', 'WORK_HUB_PLAIN_DIR']);
});

test('folderTrustError: never the root, home itself or system folders', () => {
  for (const bad of ['/', '/h', '~', '/usr/local', '/System/x', '/etc', '/private/tmp/x', '/var/db', '/Library/a', '/Applications', '/opt/x', '/bin', '/sbin']) {
    assert.ok(folderTrustError(bad, '/h'), bad);
  }
  assert.equal(folderTrustError('~/Documents/a', '/h'), null);
  assert.equal(folderTrustError('/h/Documents/a', '/h'), null);
  assert.equal(folderTrustError('/srv/work', '/h'), null);
  assert.equal(folderTrustError('/usrx/y', '/h'), null);
  assert.match(folderTrustError('rel/x', '/h')!, /absolute/);
  assert.ok(folderTrustError(5, '/h'));
});

test('folderTrustError: also refuses an ancestor of the home folder', () => {
  assert.ok(folderTrustError('/Users', '/Users/me'));
  assert.ok(folderTrustError('/Users/me', '/Users/me'));
  assert.equal(folderTrustError('/Users/me/x', '/Users/me'), null);
  assert.equal(folderTrustError('/Users/mex', '/Users/me'), null);
});
