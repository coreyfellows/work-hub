import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeLines, changesSince, snapFiles, type PrFileLike } from './since.ts';

const f = (path: string, patch: string | null, extra: Partial<PrFileLike> = {}): PrFileLike => ({
  path,
  status: 'modified',
  additions: patch ? patch.split('\n').filter((l) => l.startsWith('+')).length : 3,
  deletions: patch ? patch.split('\n').filter((l) => l.startsWith('-')).length : 1,
  patch,
  ...extra,
});

test('only +/- lines count, not hunk headers or context', () => {
  assert.equal(changeLines('@@ -1,2 +1,2 @@\n ctx\n-old\n+new').length, 2);
});

test('the same diff is no change, even with new commits', () => {
  const files = [f('a.ts', '@@ -1 +1 @@\n-a\n+b')];
  const s = changesSince(snapFiles(files), snapFiles(files));
  assert.equal(s.files, 0);
  assert.equal(s.linesAdded + s.linesRemoved, 0);
});

test('counts changed, new and gone files, and diff lines in and out', () => {
  const before = snapFiles([f('a.ts', '@@\n-a\n+b\n+c'), f('gone.ts', '@@\n+x\n+y'), f('same.ts', '@@\n+s')]);
  const now = snapFiles([f('a.ts', '@@\n-a\n+b\n+d\n+e'), f('new.ts', '@@\n+n'), f('same.ts', '@@\n+s')]);
  const s = changesSince(before, now);
  assert.deepEqual(s.changedFiles, ['a.ts']);
  assert.deepEqual(s.newFiles, ['new.ts']);
  assert.deepEqual(s.goneFiles, ['gone.ts']);
  assert.equal(s.files, 3);
  // a.ts: +d +e in, +c out; new.ts: 1 in; gone.ts: 2 out.
  assert.equal(s.linesAdded, 3);
  assert.equal(s.linesRemoved, 3);
  assert.deepEqual(s.now, { files: 3, additions: 5, deletions: 1 });
});

test('repeated identical lines are counted one for one', () => {
  const s = changesSince(snapFiles([f('a', '@@\n+x')]), snapFiles([f('a', '@@\n+x\n+x')]));
  assert.equal(s.linesAdded, 1);
});

test('without patches, moved counts still show a change', () => {
  const s = changesSince(snapFiles([f('bin.png', null, { additions: 0, deletions: 0 })]), snapFiles([f('bin.png', null, { additions: 0, deletions: 0, status: 'renamed' })]));
  assert.deepEqual(s.changedFiles, ['bin.png']);
  const same = changesSince(snapFiles([f('big', null)]), snapFiles([f('big', null)]));
  assert.equal(same.files, 0);
});
