import test from 'node:test';
import assert from 'node:assert/strict';
import { addFileRoot, fileRoots, removeFileRoots } from './fileRoots.ts';

test('plugin file roots (ctx.files.addRoot) are listed until the plugin is taken back', () => {
  assert.ok(!fileRoots().includes('/state/reviews'));
  addFileRoot('/state/reviews', 'test-plugin');
  assert.ok(fileRoots().includes('/state/reviews'));
  removeFileRoots('test-plugin');
  assert.ok(!fileRoots().includes('/state/reviews'));
});
