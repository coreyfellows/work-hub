import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCandidates, insideRoots } from './scriptPath.ts';

test('a bare script path is the candidate', () => {
  assert.deepEqual(commandCandidates('/tmp/work-hub/ui/do-thing.sh --apply'), ['/tmp/work-hub/ui/do-thing.sh']);
});

test('interpreters and flags are skipped, the script after them is found', () => {
  assert.deepEqual(commandCandidates('bash /tmp/x/run.sh --confirm gamedev,prod'), ['/tmp/x/run.sh']);
  assert.deepEqual(commandCandidates('node --watch ./scripts/seed.ts'), ['./scripts/seed.ts']);
  assert.deepEqual(commandCandidates('python3 -I tools/fix.py'), ['tools/fix.py']);
});

test('quoted paths with spaces and ~ paths work', () => {
  assert.deepEqual(commandCandidates('"/tmp/my dir/run.sh" --apply'), ['/tmp/my dir/run.sh']);
  assert.deepEqual(commandCandidates("~/bin/tool.sh 'a b'"), ['~/bin/tool.sh']);
});

test('commands with no script-like token have no candidates', () => {
  assert.deepEqual(commandCandidates('ls -la'), []);
  assert.deepEqual(commandCandidates('git status'), []);
  assert.deepEqual(commandCandidates('vault login -method=oidc'), []);
});

test('flag values are not candidates, and the list is capped', () => {
  assert.deepEqual(commandCandidates('tool --file=/etc/passwd'), []);
  assert.equal(commandCandidates('a.sh b.sh c.sh d.sh e.sh f.sh g.sh').length, 4);
});

test('insideRoots only accepts the root itself or paths under it', () => {
  assert.equal(insideRoots('/tmp/a/b.sh', ['/tmp']), true);
  assert.equal(insideRoots('/tmp', ['/tmp']), true);
  assert.equal(insideRoots('/tmpevil/b.sh', ['/tmp']), false);
  assert.equal(insideRoots('/etc/passwd', ['/tmp', '/Users/x/repos']), false);
});
