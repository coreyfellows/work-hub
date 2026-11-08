import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowArgs, checkRules, defaultRules, loadRules, saveRules } from './allowlist.ts';

test('checkRules: trims, drops blanks and duplicates, refuses non-rules', () => {
  assert.deepEqual(checkRules([' Read ', '', 'Bash(git log:*)', 'Read', 'mcp__tracker__search']), {
    ok: true,
    rules: ['Read', 'Bash(git log:*)', 'mcp__tracker__search'],
  });
  assert.equal(checkRules(['rm -rf /']).ok, false);
  assert.equal(checkRules(['Bash(']).ok, false);
  assert.equal(checkRules('Read').ok, false);
  assert.equal(checkRules([1]).ok, false);
});

test('defaultRules are all valid rules and use the configured wh and scripts paths', () => {
  const d = defaultRules({ whBin: '/r/bin/wh', ticketWorkflowScripts: '/tw/scripts/' });
  assert.deepEqual(checkRules(d), { ok: true, rules: d });
  assert.ok(d.includes('Bash(/r/bin/wh:*)'));
  assert.ok(d.includes('Bash(/tw/scripts/trust-worktree.sh:*)'));
  assert.ok(!defaultRules({ whBin: 'wh' }).some((r) => r.includes('trust-worktree')));
});

test('allowArgs: one --settings with the allow list; nothing when empty', () => {
  assert.deepEqual(allowArgs([]), []);
  const a = allowArgs(['Read']);
  assert.equal(a[0], '--settings');
  assert.deepEqual(JSON.parse(a[1]), { permissions: { allow: ['Read'] } });
});

test('saveRules/loadRules round trip; null resets to defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wh-allow-'));
  try {
    const f = join(dir, 'sub', 'allowed-tools.json');
    assert.equal(await loadRules(f), null);
    await saveRules(f, ['Read', 'Bash(ls:*)']);
    assert.deepEqual(await loadRules(f), ['Read', 'Bash(ls:*)']);
    await saveRules(f, []);
    assert.deepEqual(await loadRules(f), []);
    await saveRules(f, null);
    assert.equal(await loadRules(f), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
