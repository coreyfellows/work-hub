import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = join(import.meta.dirname, 'claude', 'scripts', 'team.sh');
const run = (args: string[], dir: string) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, WORK_HUB_SESSION_AWARENESS_DIR: dir } });

test('team.sh prints the digest Markdown, a friendly line when there is none, and usage without arguments', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-team-'));
  mkdirSync(join(dir, 'digests'));
  writeFileSync(join(dir, 'digests', 'ws.md'), '- **aaaa1111** "A" (main): working\n');
  const ok = run(['ws'], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '- **aaaa1111** "A" (main): working\n');
  const none = run(['other'], dir);
  assert.equal(none.status, 0);
  assert.equal(none.stdout, 'work-hub: no other sessions recorded for other\n');
  const usage = run([], dir);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: team\.sh <workspace-id>/);
});
