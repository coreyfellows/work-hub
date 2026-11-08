import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultShell, defaultTermdSocket, idleSeconds, keepAwakeCommand, normPath, parseGdbusIdle, parseIoregIdle, parseLoginctlIdle, platform, ptyBridgeCommand, pythonCommand } from './platform.ts';

const win = { WORK_HUB_PLATFORM: 'win32', USERNAME: 'Jo Smith', PATH: '' } as NodeJS.ProcessEnv;
const linux = { WORK_HUB_PLATFORM: 'linux' } as NodeJS.ProcessEnv;

test('platform: override for tests; anything not macOS or Windows is Linux', () => {
  assert.equal(platform({ WORK_HUB_PLATFORM: 'freebsd' } as NodeJS.ProcessEnv), 'linux');
  assert.equal(platform(win), 'win32');
});

test('idle parsers: ioreg (ns), gdbus Mutter (ms), loginctl hint', () => {
  assert.equal(parseIoregIdle('    | |   "HIDIdleTime" = 61000000000\n'), 61);
  assert.equal(parseIoregIdle('nothing'), null);
  assert.equal(parseGdbusIdle('(uint64 125000,)\n'), 125);
  assert.equal(parseLoginctlIdle('IdleHint=no\nIdleSinceHint=0\n', 0), 0);
  assert.equal(parseLoginctlIdle('IdleHint=yes\nIdleSinceHint=1000000000\n', 1_000_000 + 90_000), 90);
  assert.equal(parseLoginctlIdle('', 0), null);
});

test('idleSeconds on Linux: xprintidle, then gdbus, then loginctl, else null', async () => {
  const calls: string[] = [];
  const runner = (answers: Record<string, string>) => async (cmd: string) => {
    calls.push(cmd);
    if (cmd in answers) return answers[cmd]!;
    throw new Error('not found');
  };
  assert.equal(await idleSeconds(runner({ xprintidle: '4200\n' }), { ...linux, DISPLAY: ':0' }), 4);
  calls.length = 0;
  assert.equal(await idleSeconds(runner({ gdbus: '(uint64 3000,)' }), linux), 3);
  assert.deepEqual(calls, ['gdbus']); // no DISPLAY: xprintidle isn't tried
  assert.equal(await idleSeconds(runner({}), linux), null);
});

test('the pty bridge runs on python3, python on Windows, WORK_HUB_PYTHON over both', () => {
  assert.deepEqual(ptyBridgeCommand('/b.py', 80, 24, ['claude', 'attach', 'x'], linux), { cmd: 'python3', args: ['-u', '/b.py', '80', '24', 'claude', 'attach', 'x'] });
  assert.equal(pythonCommand(win), 'python');
  assert.equal(pythonCommand({ ...win, WORK_HUB_PYTHON: 'py' }), 'py');
});

test('default shell and termd socket per platform', () => {
  assert.deepEqual(defaultShell({ ...linux, SHELL: '/usr/bin/fish' }), { shell: '/usr/bin/fish', args: ['-l'] });
  assert.deepEqual(defaultShell({ ...win, SystemRoot: 'C:\\Windows' }).args, ['-NoLogo']);
  assert.match(defaultShell({ ...win, SystemRoot: 'C:\\Windows' }).shell, /powershell\.exe$/);
  assert.equal(defaultTermdSocket('/s', linux), '/s/termd.sock');
  assert.equal(defaultTermdSocket('C:\\s', win), '\\\\.\\pipe\\work-hub-termd-Jo-Smith');
});

test('normPath: identity on POSIX; one spelling on Windows', () => {
  assert.equal(normPath('/Users/a/b/', linux), '/Users/a/b/');
  assert.equal(normPath('c:\\Users\\a\\b\\', win), 'C:/Users/a/b');
  assert.equal(normPath('/c/Users/a', win), 'C:/Users/a');
  assert.equal(normPath('C:/', win), 'C:/');
});

test('keepAwakeCommand per platform, tied to the server pid', () => {
  assert.deepEqual(keepAwakeCommand(42, { WORK_HUB_PLATFORM: 'darwin' } as NodeJS.ProcessEnv), { cmd: 'caffeinate', args: ['-i', '-w', '42'] });
  const l = keepAwakeCommand(42, linux);
  assert.equal(l.cmd, 'systemd-inhibit');
  assert.deepEqual(l.args.slice(-4), ['tail', '--pid=42', '-f', '/dev/null']);
  const w = keepAwakeCommand(42, win);
  assert.equal(w.cmd, 'powershell.exe');
  const script = Buffer.from(w.args.at(-1)!, 'base64').toString('utf16le');
  assert.match(script, /SetThreadExecutionState\(0x80000001\)/);
  assert.match(script, /Wait-Process -Id 42/);
});
