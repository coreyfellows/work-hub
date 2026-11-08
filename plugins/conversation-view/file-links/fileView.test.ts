import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedRoots, isSensitive, resolveFileRef, splitPathRef } from './fileView.ts';

test('splitPathRef takes line suffixes off', () => {
  assert.deepEqual(splitPathRef('a/b.ts:12'), { path: 'a/b.ts', line: 12 });
  assert.deepEqual(splitPathRef('a/b.ts:12:3'), { path: 'a/b.ts', line: 12 });
  assert.deepEqual(splitPathRef('a/b.ts#L7'), { path: 'a/b.ts', line: 7 });
  assert.deepEqual(splitPathRef('a/b.ts'), { path: 'a/b.ts', line: undefined });
});

test('isSensitive', () => {
  assert.equal(isSensitive('/x/.git/config'), true);
  assert.equal(isSensitive('/x/.env.local'), true);
  assert.equal(isSensitive('/x/server.key'), true);
  assert.equal(isSensitive('/x/docs/a.md'), false);
});

test('resolves relative to bases, only inside allowed folders', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fv-')));
  const wt = join(root, 'wt');
  const other = join(root, 'other');
  await mkdir(join(wt, 'docs'), { recursive: true });
  await mkdir(other);
  await writeFile(join(wt, 'docs', 'a.md'), '# hi');
  await writeFile(join(other, 'secret.txt'), 'x');
  await symlink(join(other, 'secret.txt'), join(wt, 'link.txt'));
  const hit = await resolveFileRef('docs/a.md:3', [wt], [wt]);
  assert.deepEqual(hit, { path: join(wt, 'docs', 'a.md'), line: 3 });
  assert.equal(await resolveFileRef('docs/missing.md', [wt], [wt]), null);
  assert.equal(await resolveFileRef('../other/secret.txt', [wt], [wt]), null);
  assert.equal(await resolveFileRef(join(other, 'secret.txt'), [wt], [wt]), null);
  assert.equal(await resolveFileRef('link.txt', [wt], [wt]), null); // symlink out of the folder
  assert.equal(await resolveFileRef('docs', [wt], [wt]), null); // a directory
  assert.equal(await resolveFileRef('https://x.com/a.md', [wt], [wt]), null);
});

test('the repos root is allowed when given', () => {
  assert.ok(allowedRoots('/cwd', [], { worktreesRoot: '/wt', reposRoot: '/repos' }).includes('/repos'));
  assert.ok(!allowedRoots('/cwd', [], { worktreesRoot: '/wt' }).includes('/repos'));
});

test('extra roots (from plugins) join the allowed folders', () => {
  const base = { worktreesRoot: '/wt' };
  assert.ok(!allowedRoots('/cwd', [], base).includes('/state/reviews'));
  assert.ok(allowedRoots('/cwd', ['/wt/a'], { ...base, extraRoots: ['/state/reviews'] }).includes('/state/reviews'));
});
