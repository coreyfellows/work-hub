import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerByCwd, spawnedIds, toolOutputs, type WorktreeRec } from './reconcile.ts';

const W: WorktreeRec[] = [
  { workspaceId: 'a', repo: 'org/site-src', path: '/w/site-src/TKT-1', branch: 'f-TKT-1' },
  { workspaceId: 'b', repo: 'org/site-src', path: '/w/site-src/TKT-1/nested', branch: 'f-nested' },
  { workspaceId: 'c', repo: 'org/other', path: '/w/other/x', branch: 'main' },
];

test('ownerByCwd: deepest recorded worktree containing the cwd wins', () => {
  assert.equal(ownerByCwd('/w/site-src/TKT-1', null, null, W), 'a');
  assert.equal(ownerByCwd('/w/site-src/TKT-1/websites/app', null, null, W), 'a');
  assert.equal(ownerByCwd('/w/site-src/TKT-1/nested/deep', null, null, W), 'b');
  assert.equal(ownerByCwd('/w/site-src/TKT-10', null, null, W), null, 'a sibling with a common prefix is not inside');
});

test('ownerByCwd: falls back to a unique repo + branch, never a shared branch', () => {
  assert.equal(ownerByCwd('/repos/site-src', 'Org/Site-Src', 'f-TKT-1', W), 'a');
  assert.equal(ownerByCwd('/repos/other', 'org/other', 'main', W), null);
  assert.equal(ownerByCwd('/repos/site-src', 'org/site-src', 'f-unknown', W), null);
  const dup = [...W, { workspaceId: 'd', repo: 'org/site-src', path: '/w/site-src/dup', branch: 'f-TKT-1' }];
  assert.equal(ownerByCwd('/repos/site-src', 'org/site-src', 'f-TKT-1', dup), null, 'ambiguous');
});

test('ownerByCwd: a non-git record matches by path, never by repo + branch', () => {
  const recs: WorktreeRec[] = [
    { workspaceId: 'j', vcs: 'jj', repo: 'org/site-src', path: '/w/jj/TKT-2', branch: 'f-TKT-2' },
    { workspaceId: 'f', vcs: 'folder', repo: null, path: '/p/notes', branch: null },
  ];
  assert.equal(ownerByCwd('/w/jj/TKT-2/sub', 'org/site-src', 'f-TKT-2', recs), 'j');
  assert.equal(ownerByCwd('/p/notes', null, null, recs), 'f');
  assert.equal(ownerByCwd('/repos/site-src', 'org/site-src', 'f-TKT-2', recs), null);
  // A git record with the same repo + branch still matches; the jj one doesn't make it ambiguous.
  const both = [...recs, { workspaceId: 'g', vcs: 'git', repo: 'org/site-src', path: '/w/site-src/TKT-2', branch: 'f-TKT-2' }];
  assert.equal(ownerByCwd('/repos/site-src', 'org/site-src', 'f-TKT-2', both), 'g');
});

test('spawnedIds: only the whole line claude --bg prints', () => {
  const out = '  claude attach ddb63d29    open in this terminal\n  claude logs ddb63d29      show recent output\n  claude stop ddb63d29      stop this session';
  assert.deepEqual(spawnedIds(out), ['ddb63d29']);
  // Another transcript quoted in a tool's output (escaped newlines, JSON around it) is not a launch.
  assert.deepEqual(spawnedIds('"  claude attach ddb63d29    open in this terminal\\n  claude logs ddb63d29"'), []);
  assert.deepEqual(spawnedIds('{"stdout":"  claude attach ddb63d29    open in this terminal'), []);
  assert.deepEqual(spawnedIds('run claude attach ddb63d29 to see it'), []);
});

test('toolOutputs: structured stdout and tool_result text', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'A' }, { type: 'tool_result', content: [{ type: 'text', text: 'B' }] }, { type: 'text', text: 'C' }] },
    toolUseResult: { stdout: 'S' },
  });
  assert.deepEqual(toolOutputs(line), ['S', 'A', 'B']);
  assert.deepEqual(toolOutputs('not json'), []);
});
