import assert from 'node:assert/strict';
import test from 'node:test';
import { setFolderResolver } from '../config.ts';
import { run } from './exec.ts';

test('commands run with the folders in force as env vars; an explicit env still wins', async () => {
  setFolderResolver((w) => (w === 'repos' ? '/x/repos' : '/x/trees'));
  try {
    assert.equal((await run('/usr/bin/env', [])).match(/^TW_WORKTREES_ROOT=(.*)$/m)?.[1], '/x/trees');
    assert.equal((await run('/usr/bin/env', [])).match(/^WORK_HUB_REPOS_DIR=(.*)$/m)?.[1], '/x/repos');
    assert.equal((await run('/usr/bin/env', [], { env: { TW_WORKTREES_ROOT: '/o' } })).match(/^TW_WORKTREES_ROOT=(.*)$/m)?.[1], '/o');
  } finally {
    setFolderResolver(null);
  }
});
