import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitOps, pushRefs } from './gitOps.ts';
import { parseDiff } from '../../../plugin-api/server.ts';
import { gitEnricher } from './server.ts';

test('parseGitOps follows cd and -C and skips read-only git', () => {
  const ops = parseGitOps('cd /tmp/r && git status && git -C sub rm a.txt && git commit -qm "x; y" && git push origin main', '/home');
  assert.deepEqual(ops.map((o) => [o.sub, o.dir]), [['rm', '/tmp/r/sub'], ['commit', '/tmp/r'], ['push', '/tmp/r']]);
  assert.deepEqual(ops[0]!.files, ['a.txt']);
});

test('pushRefs reads updated and new refs', () => {
  assert.deepEqual(pushRefs('To x\n   abc1234..def5678  main -> main\n * [new branch]      feat -> feat\n'), ['main -> main', '[new branch] feat -> feat']);
});

test('parseDiff: a new file is content, a change is hunks', () => {
  const diff = 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\ndiff --git a/m.txt b/m.txt\n--- a/m.txt\n+++ b/m.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n';
  assert.deepEqual(parseDiff(diff, '/r', null), [
    { path: '/r/n.txt', tool: 'Bash', at: null, content: 'a\nb', lines: 2, created: true },
    { path: '/r/m.txt', tool: 'Bash', at: null, hunks: [{ old: 'x\ny', new: 'x\nz' }] },
  ]);
});

test('the enricher puts `git` on Bash calls in a known cwd only', () => {
  const state = gitEnricher.init!('s');
  const entry = { i: 0, at: null, kind: 'tool', id: 't1' } as never;
  assert.equal(gitEnricher.onToolUse!(entry, { name: 'Bash', input: { command: 'ls' }, raw: { cwd: '/r' } }, state), undefined);
  assert.equal(gitEnricher.onToolUse!(entry, { name: 'Bash', input: { command: 'git rm a' }, raw: {} }, state), undefined);
  const r = gitEnricher.onToolUse!(entry, { name: 'Bash', input: { command: 'git rm a' }, raw: { cwd: '/r' } }, state) as { git: Array<{ sub: string }> };
  assert.equal(r.git[0]!.sub, 'rm');
  assert.equal(state.pending.size, 1);
});
