import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasGitCopy } from './gitCopies.ts';

test('the Diff tab shows with a git copy', () => {
  assert.equal(hasGitCopy({ worktrees: [{ vcs: 'folder' }, { vcs: 'git' }] }), true);
  assert.equal(hasGitCopy({ vcs: 'jj', worktrees: [{ vcs: 'jj' }, { vcs: 'git' }] }), true);
});

test('a git (or not yet chosen) workspace with no copies yet keeps the Diff tab', () => {
  assert.equal(hasGitCopy({ worktrees: [] }), true);
  assert.equal(hasGitCopy({ vcs: null, worktrees: [] }), true);
  assert.equal(hasGitCopy({ vcs: 'git', worktrees: [] }), true);
});

test('the Diff tab is hidden for another kind of workspace, or copies none of which is git', () => {
  assert.equal(hasGitCopy({ vcs: 'folder', worktrees: [] }), false);
  assert.equal(hasGitCopy({ vcs: 'jj', worktrees: [] }), false);
  assert.equal(hasGitCopy({ worktrees: [{ vcs: 'folder' }] }), false);
  assert.equal(hasGitCopy({ vcs: null, worktrees: [{ vcs: 'jj' }] }), false);
});
