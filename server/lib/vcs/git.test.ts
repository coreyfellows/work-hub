import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gitProvider, SHARED_BRANCHES } from './git.ts';

let repo: string;

before(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wh-vcs-git-')));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'feature-x');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  mkdirSync(join(repo, 'sub'));
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('git provider: detect gives the toplevel from inside, null outside a repo', async () => {
  assert.equal(await gitProvider.detect(join(repo, 'sub')), repo);
  const plain = mkdtempSync(join(tmpdir(), 'wh-vcs-plain-'));
  try {
    assert.equal(await gitProvider.detect(plain), null);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('git provider: line is the branch with the head commit; no origin means no repo identity', async () => {
  const { line, head } = await gitProvider.line(repo);
  assert.equal(line, 'feature-x');
  assert.match(head ?? '', /^[0-9a-f]{40}$/);
  assert.deepEqual(await gitProvider.identity(repo), { repo: null });
});

test('git provider: shared lines are the old SHARED_BRANCHES', () => {
  assert.deepEqual([...gitProvider.sharedLines].sort(), ['develop', 'dev', 'main', 'master', 'trunk'].sort());
  assert.equal(gitProvider.sharedLines, SHARED_BRANCHES);
});

test('git provider: a checkout outside the worktrees folder is never removable, even with force', async () => {
  writeFileSync(join(repo, 'new.txt'), 'x');
  const s = await gitProvider.inspect(repo);
  assert.equal(s.exists, true);
  assert.equal(s.dirty, true);
  assert.equal(s.removable, false);
  assert.equal(s.block, 'outside the worktrees folder');
  await assert.rejects(gitProvider.removeWorkingCopy(repo, { force: true }), /outside the worktrees folder/);
  assert.deepEqual(gitProvider.agentInstructions({ workspaceId: 'w', ticketKey: null, whCommand: 'wh', worktreesDir: '/w' }), []);
});
