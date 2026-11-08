import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nodeCheck, runPrereqs } from './prereqs.ts';

test('nodeCheck: 26 or newer', () => {
  assert.equal(nodeCheck('v26.1.0').ok, true);
  assert.equal(nodeCheck('v22.4.0').ok, false);
});

test('runPrereqs: reports what is missing and what is not required', async () => {
  const home = await mkdtemp(join(tmpdir(), 'prereq-'));
  const run = async (cmd: string, args: string[]) => {
    if (cmd === 'gh') throw new Error('nope');
    if (cmd === 'claude' && args[0] === 'auth') return '{"loggedIn":true}';
    return `${cmd} 1.0`;
  };
  const checks = await runPrereqs(run, { home, nodeVersion: 'v26.0.0' });
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(by.git.ok, true);
  assert.equal(by['claude-auth'].ok, true);
  assert.equal(by.gh.ok, false);
  assert.equal(by.gh.required, false);
  assert.equal(by['gh-auth'].ok, false);
  assert.equal(by['claude-json'].ok, false); // no ~/.claude.json in the temp home
  await writeFile(join(home, '.claude.json'), '{}');
  assert.equal((await runPrereqs(run, { home, nodeVersion: 'v26.0.0' })).find((c) => c.id === 'claude-json')!.ok, true);
});
