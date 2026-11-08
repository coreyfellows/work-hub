import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hookSettings, launchArgs } from './hookSettings.ts';

const o = { hookPath: '/repo/plugins/session-awareness/claude/hooks/awareness.mjs', stateDir: "/Users/me/.local/state/work hub/plugins/session-awareness", nudgeIntervalMs: 300000, staleAfterMs: 600000, node: '/usr/local/bin/node' };

test('UserPromptSubmit always; PreToolUse only when nudgeIntervalMs > 0; env and paths quoted', () => {
  const s = hookSettings(o);
  assert.deepEqual(Object.keys(s.hooks), ['UserPromptSubmit', 'PreToolUse']);
  const ups = s.hooks.UserPromptSubmit[0] as { hooks: Array<{ type: string; command: string; timeout: number }> };
  assert.equal(ups.hooks[0].type, 'command');
  assert.equal(ups.hooks[0].timeout, 5);
  assert.equal(
    ups.hooks[0].command,
    "WORK_HUB_SESSION_AWARENESS_DIR='/Users/me/.local/state/work hub/plugins/session-awareness' WORK_HUB_SESSION_AWARENESS_NUDGE_MS=300000 WORK_HUB_SESSION_AWARENESS_STALE_MS=600000 '/usr/local/bin/node' '/repo/plugins/session-awareness/claude/hooks/awareness.mjs'",
  );
  const pre = s.hooks.PreToolUse[0] as { matcher?: string; hooks: Array<{ command: string }> };
  assert.equal(pre.matcher, 'Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task', 'only tools where a nudge helps');
  assert.equal((ups as { matcher?: string }).matcher, undefined, 'UserPromptSubmit has no matcher');
  assert.equal(pre.hooks[0].command, ups.hooks[0].command);
  assert.deepEqual(Object.keys(hookSettings({ ...o, nudgeIntervalMs: 0 }).hooks), ['UserPromptSubmit']);
});

test('launchArgs is one --settings argument carrying that JSON', () => {
  const args = launchArgs(o);
  assert.equal(args[0], '--settings');
  assert.deepEqual(JSON.parse(args[1]), hookSettings(o));
  assert.equal(args.length, 2);
});
