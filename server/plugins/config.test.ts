import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPluginsConfig, writePluginsConfig } from './config.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'wh-plugins-'));

test('missing file gives defaults and creates nothing', () => {
  const dir = join(tmp(), 'sub');
  const file = join(dir, 'plugins.json');
  assert.deepEqual(readPluginsConfig(file), { local: [], enabled: {} });
  assert.equal(existsSync(dir), false);
});

test('broken JSON throws naming the file', () => {
  const file = join(tmp(), 'plugins.json');
  writeFileSync(file, '{nope');
  assert.throws(() => readPluginsConfig(file), (e: Error) => e.message.includes(file));
});

test('write then read round-trips with mode 0600 and a 0700 parent', () => {
  const dir = join(tmp(), 'conf');
  const file = join(dir, 'plugins.json');
  const cfg = { local: ['/a'], enabled: { x: false }, settings: { x: { k: 1 } } };
  writePluginsConfig(file, cfg);
  assert.deepEqual(readPluginsConfig(file), cfg);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('wrong-typed values are dropped with a warning; good ones kept', () => {
  const file = join(tmp(), 'plugins.json');
  writeFileSync(
    file,
    JSON.stringify({
      local: ['/ok', 3, null],
      enabled: { a: true, b: false, c: 'false', d: 1 },
      settings: { x: { k: 1 }, y: 'nope', z: [1] },
    }),
  );
  const warnings: string[] = [];
  const cfg = readPluginsConfig(file, (m) => warnings.push(m));
  assert.deepEqual(cfg, { local: ['/ok'], enabled: { a: true, b: false }, settings: { x: { k: 1 } } });
  assert.equal(warnings.length, 6);
  assert.ok(warnings.some((w) => w.includes('enabled.c must be true or false (got "false")')));
  assert.ok(warnings.some((w) => w.includes('settings.y must be an object')));
});

test('wrong-typed sections are dropped whole', () => {
  const file = join(tmp(), 'plugins.json');
  writeFileSync(file, JSON.stringify({ local: '/x', enabled: ['a'], settings: 5 }));
  const warnings: string[] = [];
  assert.deepEqual(readPluginsConfig(file, (m) => warnings.push(m)), { local: [], enabled: {} });
  assert.equal(warnings.length, 3);
});
