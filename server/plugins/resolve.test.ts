import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlugins } from './resolve.ts';
import type { DiscoveredPlugin } from './discover.ts';
import type { PluginsConfig } from './config.ts';

function p(id: string, o: Partial<DiscoveredPlugin['manifest']> = {}, d: Partial<DiscoveredPlugin> = {}): DiscoveredPlugin {
  return { manifest: { id, apiVersion: 1, title: id, defaultEnabled: true, ...o }, dir: `/x/${id}`, official: true, ...d };
}
const cfg = (enabled: Record<string, boolean> = {}): PluginsConfig => ({ local: [], enabled });
const byId = (r: ReturnType<typeof resolvePlugins>, id: string) => r.plugins.find((x) => x.manifest.id === id)!;

test('defaultEnabled decides when config is silent', () => {
  const r = resolvePlugins([p('a'), p('b', { defaultEnabled: false })], cfg());
  assert.equal(byId(r, 'a').status, 'active');
  assert.equal(byId(r, 'b').status, 'disabled');
});

test('explicit config wins over the default', () => {
  const r = resolvePlugins([p('a'), p('b', { defaultEnabled: false })], cfg({ a: false, b: true }));
  assert.equal(byId(r, 'a').status, 'disabled');
  assert.equal(byId(r, 'b').status, 'active');
});

test('apiVersion mismatch is skipped with a CHANGELOG pointer', () => {
  const r = resolvePlugins([p('a', { apiVersion: 2 })], cfg());
  assert.equal(byId(r, 'a').status, 'skipped');
  assert.equal(byId(r, 'a').reason, 'needs plugin API v1 (declares v2): it is newer than this work-hub, so update work-hub (CHANGELOG.md, "Versioning policy")');
  const old = resolvePlugins([p('a', { apiVersion: 0 })], cfg());
  assert.equal(byId(old, 'a').reason, 'needs plugin API v1 (declares v0): see CHANGELOG.md, "Plugin API 1" → "Migration steps"');
});

test('a manifest error is skipped', () => {
  const r = resolvePlugins([p('a', {}, { error: 'bad json' })], cfg());
  assert.equal(byId(r, 'a').status, 'skipped');
  assert.match(byId(r, 'a').reason!, /bad json/);
});

test('duplicate ids: the local one is skipped', () => {
  const r = resolvePlugins([p('a'), p('a', {}, { official: false, dir: '/loc/a' })], cfg());
  const [off, loc] = r.plugins;
  assert.equal(off.status, 'active');
  assert.equal(loc.status, 'skipped');
  assert.match(loc.reason!, /duplicate id/);
});

test('an enabled replacer hides the official plugin', () => {
  const r = resolvePlugins([p('a'), p('b', { replaces: 'a' }, { official: false })], cfg());
  assert.equal(byId(r, 'a').status, 'replaced');
  assert.equal(byId(r, 'a').replacedBy, 'b');
  assert.equal(byId(r, 'b').status, 'active');
});

test('a disabled replacer replaces nothing', () => {
  const r = resolvePlugins([p('a'), p('b', { replaces: 'a', defaultEnabled: false })], cfg());
  assert.equal(byId(r, 'a').status, 'active');
});

test('replacing an unknown id is fine, with a note', () => {
  const r = resolvePlugins([p('b', { replaces: 'zzz' })], cfg());
  assert.equal(byId(r, 'b').status, 'active');
  assert.match(byId(r, 'b').reason!, /zzz/);
  assert.deepEqual(r.errors, []);
});

test('two replacers of the same id: both skipped and an error', () => {
  const r = resolvePlugins([p('a'), p('b', { replaces: 'a' }), p('c', { replaces: 'a' })], cfg());
  assert.equal(byId(r, 'b').status, 'skipped');
  assert.equal(byId(r, 'c').status, 'skipped');
  assert.equal(byId(r, 'a').status, 'active');
  assert.equal(r.errors.length, 1);
});

test('requires cascades to a fixed point', () => {
  const r = resolvePlugins(
    [p('a', { defaultEnabled: false }), p('b', { requires: ['a'] }), p('c', { requires: ['b'] })],
    cfg(),
  );
  assert.equal(byId(r, 'b').status, 'skipped');
  assert.equal(byId(r, 'b').reason, 'requires a, which is off');
  assert.equal(byId(r, 'c').status, 'skipped');
});

test('requires is satisfied by an active plugin', () => {
  const r = resolvePlugins([p('a'), p('b', { requires: ['a'] })], cfg());
  assert.equal(byId(r, 'b').status, 'active');
});

test('an alias id in config counts for the new id', () => {
  const r = resolvePlugins([p('new', { aliases: ['old'], defaultEnabled: true })], cfg({ old: false }));
  assert.equal(byId(r, 'new').status, 'disabled');
});

test('enabled: only own keys with real booleans count (a prototype name or a string falls back to the default)', () => {
  const enabled = JSON.parse('{"b": "false"}') as Record<string, boolean>;
  const r = resolvePlugins([p('constructor', { defaultEnabled: false }), p('b')], { local: [], enabled });
  assert.equal(byId(r, 'constructor').status, 'disabled');
  assert.equal(byId(r, 'b').status, 'active');
});
