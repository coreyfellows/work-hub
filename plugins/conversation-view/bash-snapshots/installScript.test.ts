import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only ever against a temp settings file (CLAUDE_SETTINGS_FILE): never the real ~/.claude/settings.json.
const script = join(import.meta.dirname, 'setup', 'install-bash-hook.sh');
const hasJq = spawnSync('jq', ['--version']).status === 0;

function withSettings(initial: unknown, fn: (file: string, run: (...args: string[]) => string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'wh-bash-hook-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(initial, null, 2));
  try {
    fn(file, (...args) => execFileSync(script, args, { env: { ...process.env, CLAUDE_SETTINGS_FILE: file, WORK_HUB_STATE_DIR: '/tmp/wh-st' }, encoding: 'utf8' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const commands = (file: string) => {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  return Object.fromEntries(Object.entries(s.hooks ?? {}).map(([ev, gs]) => [ev, (gs as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((h) => h.command))]));
};

const stale = {
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: "WORK_HUB_STATE_DIR='/old' '/moved/checkout/hooks/bash-snapshot.sh' pre" }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: '/x/my-bash-snapshot.sh' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
  },
};

test('install-bash-hook: dry run leaves the file alone', { skip: !hasJq && 'jq missing' }, () => {
  withSettings(stale, (file, run) => {
    const before = readFileSync(file, 'utf8');
    assert.match(run(), /Dry run/);
    assert.equal(readFileSync(file, 'utf8'), before);
  });
});

test('install-bash-hook: replaces entries for any bash-snapshot.sh, keeps others; --dir pins the folder', { skip: !hasJq && 'jq missing' }, () => {
  withSettings(stale, (file, run) => {
    run('--apply', '--dir', '/tmp/wh-snaps');
    const c = commands(file);
    assert.equal(c.PreToolUse!.length, 2);
    assert.equal(c.PreToolUse![0], '/x/my-bash-snapshot.sh');
    assert.equal(c.PreToolUse![1], `WORK_HUB_BASH_SNAP_DIR='/tmp/wh-snaps' '${script.replace('setup/install-bash-hook.sh', 'claude/hooks/bash-snapshot.sh')}' pre`);
    assert.equal(c.PostToolUse!.length, 1);
    assert.equal(c.PostToolUseFailure!.length, 1);
    assert.deepEqual(c.Stop, ['say done']);
    assert.match(run('--apply', '--dir', '/tmp/wh-snaps'), /Nothing to change/);
    run('--apply');
    assert.match(commands(file).PreToolUse![1]!, /^WORK_HUB_STATE_DIR='\/tmp\/wh-st' '/);
    run('--remove');
    assert.deepEqual(commands(file), { PreToolUse: ['/x/my-bash-snapshot.sh'], Stop: ['say done'] });
  });
});

test('install-bash-hook: --dir without a path is refused', { skip: !hasJq && 'jq missing' }, () => {
  withSettings({}, (file) => {
    const r = spawnSync(script, ['--dir'], { env: { ...process.env, CLAUDE_SETTINGS_FILE: file }, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--dir needs a path/);
  });
});
