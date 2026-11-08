import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFragment, fragments, removeFragments } from './prompts.ts';

test('fragments: registration order, only the asked kind, empty ones dropped', () => {
  addFragment('workspace-rules', () => 'first', 'a');
  addFragment('explorer', () => 'explorer only', 'a');
  addFragment('workspace-rules', (c) => `second for ${c.workspaceId}`, 'b');
  addFragment('workspace-rules', () => '   ', 'b');
  addFragment('workspace-rules', () => null, 'b');
  assert.equal(fragments('workspace-rules', { workspaceId: 'w1' }), 'first\n\nsecond for w1');
  assert.equal(fragments('explorer'), 'explorer only');
  assert.equal(fragments('session-context'), '');
});

test('removeFragments drops one owner only', () => {
  removeFragments('a');
  assert.equal(fragments('workspace-rules', { workspaceId: 'w2' }), 'second for w2');
  assert.equal(fragments('explorer'), '');
  removeFragments('b');
  assert.equal(fragments('workspace-rules'), '');
});
