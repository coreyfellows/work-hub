import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SettingDef } from '../plugin-api/manifest.ts';
import { applySettings, checkValue, coerceEnv, registerSettingsGroup, removeSettingsGroup, resolveSetting, settingsGroups } from './settings.ts';

const num: SettingDef = { key: 'n', label: 'N', type: 'number', default: 5, min: 1, max: 10 };
const bool: SettingDef = { key: 'b', label: 'B', type: 'boolean', default: false };
const sel: SettingDef = { key: 's', label: 'S', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' };

test('resolution: env, then plugins.json, then stored, then the default', () => {
  const env = { X: '7' };
  assert.deepEqual(resolveSetting(num, { env, envName: 'X', fileValue: 8, stored: 9 }), { value: 7, source: 'env', envName: 'X' });
  assert.deepEqual(resolveSetting(num, { env: {}, envName: 'X', fileValue: 8, stored: 9 }), { value: 8, source: 'plugins.json' });
  assert.deepEqual(resolveSetting(num, { stored: 9 }), { value: 9, source: 'app' });
  assert.deepEqual(resolveSetting(num, {}), { value: 5, source: 'default' });
});

test('an env var that does not parse is ignored', () => {
  assert.equal(coerceEnv('abc', num), undefined);
  assert.equal(coerceEnv('', num), undefined);
  assert.equal(coerceEnv('maybe', bool), undefined);
  assert.equal(coerceEnv('yes', bool), true);
  assert.deepEqual(resolveSetting(num, { env: { X: 'abc' }, envName: 'X' }), { value: 5, source: 'default' });
});

test('checkValue: types, ranges, options, null clears', () => {
  assert.deepEqual(checkValue(num, 3), { ok: true, value: 3 });
  assert.equal(checkValue(num, 0).ok, false);
  assert.equal(checkValue(num, 11).ok, false);
  assert.equal(checkValue(num, '3').ok, false);
  assert.equal(checkValue(num, NaN).ok, false);
  assert.equal(checkValue(bool, 'true').ok, false);
  assert.equal(checkValue(sel, 'c').ok, false);
  assert.deepEqual(checkValue(sel, 'b'), { ok: true, value: 'b' });
  assert.deepEqual(checkValue(num, null), { ok: true, value: null });
  assert.equal(checkValue({ key: 't', label: 'T', type: 'string' }, 'x'.repeat(1001)).ok, false);
  assert.equal(checkValue({ key: 't', label: 'T', type: 'text' }, 'x'.repeat(1001)).ok, true);
});

test('applySettings changes nothing when any entry is bad', () => {
  registerSettingsGroup({ id: 'testgrp', title: 'T', order: 1, defs: [num, bool] });
  try {
    const stored: Array<[string, unknown]> = [];
    const store = (k: string, v: unknown) => void stored.push([k, v]);
    assert.match(applySettings({ 'testgrp.n': 4, 'testgrp.b': 'x' }, store) ?? '', /true or false/);
    assert.match(applySettings({ 'testgrp.nope': 1 }, store) ?? '', /unknown setting/);
    assert.match(applySettings([], store) ?? '', /expected/);
    assert.deepEqual(stored, []);
    assert.equal(applySettings({ 'testgrp.n': 4, 'testgrp.b': null }, store), null);
    assert.deepEqual(stored, [['testgrp.n', 4], ['testgrp.b', null]]);
  } finally {
    removeSettingsGroup('testgrp');
  }
});

test('groups sort by order, then title', () => {
  registerSettingsGroup({ id: 'g2', title: 'B', order: 5, defs: [] });
  registerSettingsGroup({ id: 'g1', title: 'A', order: 5, defs: [] });
  registerSettingsGroup({ id: 'g0', title: 'Z', order: 1, defs: [] });
  try {
    assert.deepEqual(settingsGroups().map((g) => g.id), ['g0', 'g1', 'g2']);
  } finally {
    for (const id of ['g0', 'g1', 'g2']) removeSettingsGroup(id);
  }
});
