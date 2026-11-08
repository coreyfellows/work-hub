import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '../../plugin-api/server.ts';
import { codeLinks } from './code.ts';

const worktrees = [
  { repo: 'owner/app', path: '/wt/app x', branch: 'TKT-1' },
  { repo: 'solo', path: '/wt/solo', branch: null },
] as Workspace['worktrees'];

test('no token file (or an empty one) = no links', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-test-'));
  assert.deepEqual(await codeLinks({ worktrees }, { url: '/code', tokenFile: join(dir, 'missing') }), []);
  writeFileSync(join(dir, 'empty'), '\n');
  assert.deepEqual(await codeLinks({ worktrees }, { url: '/code', tokenFile: join(dir, 'empty') }), []);
});

test('one link per worktree, labelled repo@branch, token and folder encoded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-test-'));
  writeFileSync(join(dir, 'token'), 'a+b\n');
  assert.deepEqual(await codeLinks({ worktrees }, { url: '/code', tokenFile: join(dir, 'token') }), [
    { label: 'app@TKT-1', path: '/wt/app x', url: '/code/?tkn=a%2Bb&folder=%2Fwt%2Fapp%20x' },
    { label: 'solo', path: '/wt/solo', url: '/code/?tkn=a%2Bb&folder=%2Fwt%2Fsolo' },
  ]);
});
