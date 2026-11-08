import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { generalStartDir, newTerminalOptions } from './routes.ts';

const ctxWith = (cfg: Record<string, unknown>) => ({ config: { get: (k: string, d?: unknown) => (k in cfg ? cfg[k] : d) } }) as unknown as ServerPluginContext;

test('defaults: login shell, -l, 5000 lines', () => {
  assert.deepEqual(newTerminalOptions(ctxWith({}), false), { shellArgs: ['-l'], scrollback: 5000 });
  // Windows: the default -l is left to the daemon (PowerShell's -NoLogo); a chosen shell keeps its arguments.
  assert.deepEqual(newTerminalOptions(ctxWith({}), true), { scrollback: 5000 });
  assert.deepEqual(newTerminalOptions(ctxWith({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }), true), { shell: 'C:\\Program Files\\Git\\bin\\bash.exe', shellArgs: ['-l'], scrollback: 5000 });
});

test('a configured shell and arguments are passed on; arguments split on spaces', () => {
  assert.deepEqual(newTerminalOptions(ctxWith({ shell: ' /bin/bash ', shellArgs: ' -l   -i ', scrollback: 12000 })), { shell: '/bin/bash', shellArgs: ['-l', '-i'], scrollback: 12000 });
});

test('empty arguments mean a plain shell; a junk scrollback falls back', () => {
  assert.deepEqual(newTerminalOptions(ctxWith({ shellArgs: '', scrollback: 'x' })), { shellArgs: [], scrollback: 5000 });
});

test('start folder: ~ expands, absolute paths stay, anything else means the default', () => {
  assert.equal(generalStartDir(ctxWith({})), undefined);
  assert.equal(generalStartDir(ctxWith({ startDir: '~' })), homedir());
  assert.equal(generalStartDir(ctxWith({ startDir: '~/code' })), join(homedir(), 'code'));
  assert.equal(generalStartDir(ctxWith({ startDir: '/srv/work' })), '/srv/work');
  assert.equal(generalStartDir(ctxWith({ startDir: 'relative/dir' })), undefined);
});
