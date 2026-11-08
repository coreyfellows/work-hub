import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkFolder, expandFolder, folderError, foldersGroup } from './folders.ts';

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
