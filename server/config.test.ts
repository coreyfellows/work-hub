import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { whCommand } from './config.ts';

const home = '/Users/me';
const defaults = {
  stateDir: '/Users/me/.local/state/work-hub',
  configDir: '/Users/me/.config/work-hub',
  cacheDir: '/Users/me/.cache/work-hub',
  dbFile: '/Users/me/.local/state/work-hub/hub.db',
};

test('whCommand: the bare path for a default install', () => {
  assert.equal(whCommand('/repo/bin/wh', defaults, home), '/repo/bin/wh');
});

test('whCommand: every dir whose effective value is not the $HOME default goes in front (WORK_HUB_* or XDG_* alike)', () => {
  // e.g. XDG_STATE_HOME=/x without WORK_HUB_STATE_DIR: the effective state dir is /x/work-hub, and the DB follows it.
  assert.equal(
    whCommand('/repo/bin/wh', { ...defaults, stateDir: '/x/work-hub', dbFile: '/x/work-hub/hub.db' }, home),
    'WORK_HUB_STATE_DIR=/x/work-hub /repo/bin/wh',
  );
  assert.equal(
    whCommand('/r/wh', { stateDir: '/st', configDir: '/cf', cacheDir: '/ca', dbFile: '/elsewhere.db' }, home),
    'WORK_HUB_STATE_DIR=/st WORK_HUB_CONFIG_DIR=/cf WORK_HUB_CACHE_DIR=/ca WORK_HUB_DB=/elsewhere.db /r/wh',
  );
});

test('whCommand: values and the path itself are quoted when they need it', () => {
  assert.equal(
    whCommand("/my repos/bin/wh", { ...defaults, stateDir: "/it's", dbFile: "/it's/hub.db" }, home),
    "WORK_HUB_STATE_DIR='/it'\\''s' '/my repos/bin/wh'",
  );
});

test('whCommand: the command line really runs with those values in a shell', () => {
  const cmd = whCommand('env', { ...defaults, stateDir: "/a b/it's", dbFile: "/a b/it's/hub.db" }, home);
  const out = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.match(out, /^WORK_HUB_STATE_DIR=\/a b\/it's$/m);
  assert.doesNotMatch(out, /WORK_HUB_DB=/);
});
