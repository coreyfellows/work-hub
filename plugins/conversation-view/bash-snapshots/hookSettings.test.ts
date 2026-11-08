import test from 'node:test';
import assert from 'node:assert/strict';
import { hookSettings, launchArgs } from './hookSettings.ts';

test('hookSettings: Pre/Post/PostFailure Bash hooks pointing at the script with the snapshot dir', () => {
  const s = hookSettings('/p/bash-snapshot.sh', '/s/bash-snaps');
  assert.deepEqual(Object.keys(s.hooks), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
  const cmd = (ev: string) => (s.hooks[ev]![0] as { matcher: string; hooks: Array<{ command: string; type: string }> });
  assert.equal(cmd('PreToolUse').matcher, 'Bash');
  assert.equal(cmd('PreToolUse').hooks[0]!.command, "WORK_HUB_BASH_SNAP_DIR='/s/bash-snaps' '/p/bash-snapshot.sh' pre");
  assert.match(cmd('PostToolUse').hooks[0]!.command, / post$/);
  assert.match(cmd('PostToolUseFailure').hooks[0]!.command, / post$/);
});

test('launchArgs: --settings with the JSON; quotes in paths are escaped', () => {
  const a = launchArgs("/p/it's/h.sh", '/s');
  assert.equal(a[0], '--settings');
  assert.equal(a.length, 2);
  const parsed = JSON.parse(a[1]!);
  assert.match(parsed.hooks.PreToolUse[0].hooks[0].command, /'\/p\/it'\\''s\/h\.sh' pre$/);
});
