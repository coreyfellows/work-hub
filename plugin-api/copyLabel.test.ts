import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyLabel, copyLabelText } from './copyLabel.ts';

test('a git copy reads as repo name and @branch, as before', () => {
  assert.deepEqual(copyLabel({ vcs: 'git', repo: 'org/app', path: '/w/app-x', branch: 'feat' }), { name: 'app', detail: '@feat' });
  assert.deepEqual(copyLabel({ vcs: 'git', repo: 'org/app', path: '/w/app-x', branch: null }), { name: 'app', detail: '@?' });
  assert.equal(copyLabelText({ vcs: 'git', repo: 'org/app', path: '/w/x', branch: 'feat' }), 'app @feat');
});

test('a plain folder shows its folder name and nothing else', () => {
  assert.deepEqual(copyLabel({ vcs: 'folder', repo: null, path: '/Users/me/notes/', branch: null }), { name: 'notes', detail: null });
  assert.equal(copyLabelText({ vcs: 'folder', repo: null, path: '/Users/me/notes', branch: null }), 'notes');
});

test('another provider shows the folder name, its id and branch', () => {
  assert.deepEqual(copyLabel({ vcs: 'jj', repo: null, path: '/w/copy', branch: 'main' }), { name: 'copy', detail: 'jj main' });
  assert.deepEqual(copyLabel({ vcs: 'p4', repo: null, path: '/w/ws', branch: null }), { name: 'ws', detail: 'p4 ' });
});

test('a null repo never throws', () => {
  assert.deepEqual(copyLabel({ vcs: 'git', repo: null, path: '/w/x', branch: 'b' }), { name: '', detail: '@b' });
});
