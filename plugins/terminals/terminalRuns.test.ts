import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTerminalLog, wrapperLine } from './terminalRuns.ts';

test('cleanTerminalLog strips escapes and applies CR overwrites and backspaces', () => {
  const raw = '^D\b\b\x1b]0;title\x07\x1b[1;32mok\x1b[0m\r\nprogress 10%\rprogress 100%\r\nab\bc\r\n\r\n';
  assert.equal(cleanTerminalLog(raw), 'ok\nprogress 100%\nac');
});

test('cleanTerminalLog keeps plain text as is', () => {
  assert.equal(cleanTerminalLog('one\ntwo'), 'one\ntwo');
});

test('wrapperLine: as is on macOS/Linux; through Git Bash from PowerShell on Windows, or as is for a bash shell', () => {
  assert.equal(wrapperLine('/repo/bin/wh-term-run', 7, '/state/term runs'), "/repo/bin/wh-term-run 7 '/state/term runs'");
  const win = { windows: true, gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe' };
  assert.equal(
    wrapperLine('C:\\work-hub\\bin\\wh-term-run', 7, "C:\\Users\\o'neil\\state", win),
    "& 'C:\\Program Files\\Git\\bin\\bash.exe' 'C:/work-hub/bin/wh-term-run' 7 'C:/Users/o''neil/state'",
  );
  assert.equal(wrapperLine('C:\\work-hub\\bin\\wh-term-run', 7, 'C:\\state', { ...win, shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }), 'C:/work-hub/bin/wh-term-run 7 C:/state');
  assert.throws(() => wrapperLine('C:\\w', 1, 'C:\\s', { windows: true, gitBash: null }), /Git Bash not found/);
});
