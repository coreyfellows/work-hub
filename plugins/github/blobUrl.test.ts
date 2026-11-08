import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blobLabel, parseBlobUrl, refSplits } from './blobUrl.ts';

const SHA = '1cf5a1a6ac7cf0c358d8c7b903bbbc3980554424';

test('parseBlobUrl: host, repo, ref + path segments and a line range', () => {
  const l = parseBlobUrl(`https://GitHub.example.net/web-team/site-src/blob/${SHA}/docs/run%20book.md#L36-L44`);
  assert.deepEqual(l, { host: 'github.example.net', owner: 'web-team', repo: 'site-src', rest: [SHA, 'docs', 'run book.md'], lines: { from: 36, to: 44 } });
});

test('parseBlobUrl: one line, columns, no anchor, reversed range', () => {
  assert.deepEqual(parseBlobUrl(`https://h/o/r/blob/main/a.ts#L7`)?.lines, { from: 7, to: 7 });
  assert.deepEqual(parseBlobUrl(`https://h/o/r/blob/main/a.ts#L7C3-L9C1`)?.lines, { from: 7, to: 9 });
  assert.deepEqual(parseBlobUrl(`https://h/o/r/blob/main/a.ts#L9-L7`)?.lines, { from: 7, to: 9 });
  assert.equal(parseBlobUrl(`https://h/o/r/blob/main/a.ts`)?.lines, undefined);
  assert.equal(parseBlobUrl(`https://h/o/r/blob/main/a.ts#readme`)?.lines, undefined);
});

test('parseBlobUrl: not a file link', () => {
  for (const u of ['', 'not a url', 'mailto:x@y', 'https://h/o/r/tree/main/a', 'https://h/o/r/blob/main', 'https://h/o/r/pull/3', 'https://h/o/r/blob/main/../x', 'https://h/o%2Fx/r/blob/main/a'])
    assert.equal(parseBlobUrl(u), null, u);
});

test('refSplits: a SHA is the whole ref; a branch may hold slashes', () => {
  assert.deepEqual(refSplits([SHA, 'a', 'b.ts']), [{ ref: SHA, path: 'a/b.ts' }]);
  assert.deepEqual(refSplits(['feature', 'x', 'a.ts']), [
    { ref: 'feature', path: 'x/a.ts' },
    { ref: 'feature/x', path: 'a.ts' },
  ]);
  assert.equal(refSplits(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 4).length, 4);
});

test('blobLabel: ref and path for a title', () => {
  assert.deepEqual(blobLabel(parseBlobUrl(`https://h/o/r/blob/${SHA}/a/b.ts`)!), { ref: SHA, path: 'a/b.ts' });
  assert.deepEqual(blobLabel(parseBlobUrl(`https://h/o/r/blob/main/a/b.ts`)!), { ref: 'main', path: 'a/b.ts' });
});
