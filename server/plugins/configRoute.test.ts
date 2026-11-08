import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { mergePluginsConfig, registerPluginsConfigRoutes } from './configRoute.ts';

const known = new Set(['github', 'old-github', 'terminal']);
const cur = { local: ['/a'], enabled: { terminal: false }, settings: { github: { k: 1 } } };

test('merges local and enabled over the current file, keeping settings', () => {
  const r = mergePluginsConfig(cur, { enabled: { github: false } }, () => known);
  assert.deepEqual(r, { ok: true, config: { local: ['/a'], enabled: { terminal: false, github: false }, settings: { github: { k: 1 } } } });
  const r2 = mergePluginsConfig(cur, { local: ['/b', '/b', ' /c '] }, () => known);
  assert.deepEqual(r2.ok && r2.config.local, ['/b', '/c']);
});

test('a stale switch for a plugin that is gone never blocks a save', () => {
  const stale = { local: ['/old'], enabled: { gone: true, github: false } };
  const r = mergePluginsConfig(stale, { local: [], enabled: { gone: true, github: true } }, () => new Set(['github']));
  assert.deepEqual(r, { ok: true, config: { local: [], enabled: { gone: true, github: true } } });
  // Only what the client changed (the UI sends just that) also works, and the stale entry stays as it was.
  const r2 = mergePluginsConfig(stale, { enabled: { github: true } }, () => new Set(['github']));
  assert.deepEqual(r2.ok && r2.config.enabled, { gone: true, github: true });
  // Changing an unknown id is still refused.
  const r3 = mergePluginsConfig(stale, { enabled: { gone: false } }, () => new Set(['github']));
  assert.equal(r3.ok, false);
});

test('aliases count as known ids', () => {
  const r = mergePluginsConfig(cur, { enabled: { 'old-github': true } }, () => known);
  assert.equal(r.ok, true);
});

test('rejects bad bodies', () => {
  const bad = (body: unknown) => {
    const r = mergePluginsConfig(cur, body, () => known);
    assert.equal(r.ok, false, JSON.stringify(body));
    return r.ok ? '' : r.error;
  };
  assert.match(bad(null), /object/);
  assert.match(bad([]), /object/);
  assert.match(bad({ local: 'x' }), /local/);
  assert.match(bad({ local: [1] }), /local/);
  assert.match(bad({ local: ['relative/path'] }), /absolute/);
  assert.match(bad({ enabled: [] }), /enabled/);
  assert.match(bad({ enabled: { github: 'yes' } }), /boolean/);
  assert.match(bad({ enabled: { nope: true } }), /unknown plugin/);
  assert.match(bad({ other: 1 }), /unknown field/);
});

test('ids are checked against the plugins found with the new local list', () => {
  let seen: string[] = [];
  const r = mergePluginsConfig(cur, { local: ['/new'], enabled: { fresh: true } }, (local) => {
    seen = local;
    return new Set(local.includes('/new') ? ['fresh'] : []);
  });
  assert.deepEqual(seen, ['/new']);
  assert.equal(r.ok, true);
});

test('routes: GET reads the file, POST validates, writes and answers with the new config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-cfgroute-'));
  const official = join(dir, 'plugins');
  mkdirSync(join(official, 'demo'), { recursive: true });
  writeFileSync(join(official, 'demo', 'plugin.json'), JSON.stringify({ id: 'demo', apiVersion: 1, title: 'Demo', defaultEnabled: true, aliases: ['old-demo'] }));
  const file = join(dir, 'conf', 'plugins.json');
  const app = new Hono();
  registerPluginsConfigRoutes(app, { pluginsFile: file, officialDir: official });

  let res = await app.request('/api/plugins/config');
  assert.deepEqual(await res.json(), { local: [], enabled: {} });

  res = await app.request('/api/plugins/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: { demo: false } }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { local: [], enabled: { demo: false } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { local: [], enabled: { demo: false } });

  res = await app.request('/api/plugins/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: { ghost: true } }) });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /unknown plugin/);

  res = await app.request('/api/plugins/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
});

test('POST refuses (409) and writes nothing when the file has entries the reader dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-cfgroute-'));
  const official = join(dir, 'plugins');
  mkdirSync(join(official, 'demo'), { recursive: true });
  writeFileSync(join(official, 'demo', 'plugin.json'), JSON.stringify({ id: 'demo', apiVersion: 1, title: 'Demo', defaultEnabled: true }));
  mkdirSync(join(dir, 'conf'));
  const file = join(dir, 'conf', 'plugins.json');
  const original = JSON.stringify({ enabled: { demo: 'false' }, settings: { demo: { k: 1 } } });
  writeFileSync(file, original);
  const app = new Hono();
  registerPluginsConfigRoutes(app, { pluginsFile: file, officialDir: official });
  const res = await app.request('/api/plugins/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: { demo: true } }) });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; warnings: string[] };
  assert.equal(body.error, 'plugins.json has invalid entries; fix the file first');
  assert.equal(body.warnings.length, 1);
  assert.match(body.warnings[0], /enabled\.demo must be true or false/);
  assert.equal(readFileSync(file, 'utf8'), original, 'the file is untouched');
});
