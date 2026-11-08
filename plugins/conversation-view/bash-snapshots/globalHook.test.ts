import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGlobalHook, hookDir, snapshotHookCommands, userSettingsPath } from './globalHook.ts';

const settings = (cmd: string) =>
  JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${cmd} pre` }] }], Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } });

test('snapshotHookCommands finds commands running bash-snapshot.sh, by basename', () => {
  assert.deepEqual(snapshotHookCommands(JSON.parse(settings("'/old/checkout/hooks/bash-snapshot.sh'"))), ["'/old/checkout/hooks/bash-snapshot.sh' pre"]);
  assert.deepEqual(snapshotHookCommands(JSON.parse(settings('/x/my-bash-snapshot.sh'))), []);
  assert.deepEqual(snapshotHookCommands(JSON.parse(settings('/x/bash-snapshot.sh.bak'))), []);
  assert.deepEqual(snapshotHookCommands({}), []);
  assert.deepEqual(snapshotHookCommands({ hooks: { PreToolUse: 'nope' } }), []);
  assert.deepEqual(snapshotHookCommands(null), []);
});

test('hookDir: command prefix beats the inherited env, SNAP_DIR beats STATE_DIR', () => {
  const home = '/h';
  assert.equal(hookDir("'/x/bash-snapshot.sh' pre", {}, home), '/h/.local/state/work-hub/bash-snaps');
  assert.equal(hookDir("'/x/bash-snapshot.sh' pre", { XDG_STATE_HOME: '/xdg' }, home), '/xdg/work-hub/bash-snaps');
  assert.equal(hookDir("'/x/bash-snapshot.sh' pre", { WORK_HUB_STATE_DIR: '/st' }, home), '/st/bash-snaps');
  assert.equal(hookDir("WORK_HUB_STATE_DIR='/a' '/x/bash-snapshot.sh' pre", { WORK_HUB_STATE_DIR: '/st' }, home), '/a/bash-snaps');
  assert.equal(hookDir("WORK_HUB_STATE_DIR='/a' '/x/bash-snapshot.sh' pre", { WORK_HUB_BASH_SNAP_DIR: '/env-snaps' }, home), '/env-snaps');
  assert.equal(hookDir("WORK_HUB_BASH_SNAP_DIR=/s WORK_HUB_STATE_DIR='/a' /x/bash-snapshot.sh pre", {}, home), '/s');
});

test('classifyGlobalHook: none, same folder (skip ours) or elsewhere (keep ours)', () => {
  const env = { WORK_HUB_STATE_DIR: '/st' };
  assert.deepEqual(classifyGlobalHook(null, '/st/bash-snaps', env), { kind: 'none' });
  assert.deepEqual(classifyGlobalHook('not json', '/st/bash-snaps', env), { kind: 'none' });
  assert.deepEqual(classifyGlobalHook(settings('say'), '/st/bash-snaps', env), { kind: 'none' });
  assert.equal(classifyGlobalHook(settings("WORK_HUB_STATE_DIR='/st' '/r/bash-snapshot.sh'"), '/st/bash-snaps/', env).kind, 'same');
  assert.equal(classifyGlobalHook(settings("'/r/bash-snapshot.sh'"), '/st/bash-snaps', env).kind, 'same');
  const other = classifyGlobalHook(settings("WORK_HUB_STATE_DIR='/live' '/r/bash-snapshot.sh'"), '/st/bash-snaps', env);
  assert.equal(other.kind, 'elsewhere');
  assert.equal(other.kind === 'elsewhere' && other.dir, '/live/bash-snaps');
});

test('userSettingsPath: CLAUDE_SETTINGS_FILE, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
  assert.equal(userSettingsPath({ CLAUDE_SETTINGS_FILE: '/t/s.json' }, '/h'), '/t/s.json');
  assert.equal(userSettingsPath({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), '/c/settings.json');
  assert.equal(userSettingsPath({}, '/h'), '/h/.claude/settings.json');
});
