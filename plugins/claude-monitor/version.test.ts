import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, maxVersion, newer, parseVersion, pickChannel, versionFromCli, versionFromDistTags } from './version.ts';

test('parseVersion and compareVersions', () => {
  assert.deepEqual(parseVersion('2.1.319'), [2, 1, 319]);
  assert.deepEqual(parseVersion('v2.1.0-beta.1'), [2, 1, 0]);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(null), null);
  assert.ok(compareVersions('2.1.10', '2.1.9') > 0, 'numeric, not lexical');
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
  assert.ok(compareVersions('nope', '0.0.1') < 0, 'unparsable sorts first');
  assert.ok(newer('2.2.0', '2.1.999'));
  assert.ok(!newer('2.1.0', '2.1.0'));
  assert.ok(newer('1.0.0', null));
});

test('maxVersion ignores junk', () => {
  assert.equal(maxVersion('2.1.3', null, 'x', '2.1.10', undefined), '2.1.10');
  assert.equal(maxVersion(null, undefined), null);
});

test('versionFromCli', () => {
  assert.equal(versionFromCli('2.1.319 (Claude Code)\n'), '2.1.319');
  assert.equal(versionFromCli('command not found'), null);
});

test('pickChannel: setting wins, auto follows Claude settings', () => {
  assert.equal(pickChannel('stable', { autoUpdatesChannel: 'latest' }), 'stable');
  assert.equal(pickChannel('auto', { autoUpdatesChannel: 'stable' }), 'stable');
  assert.equal(pickChannel('auto', {}), 'latest');
  assert.equal(pickChannel('auto', null), 'latest');
});

test('versionFromDistTags', () => {
  const tags = { latest: '2.1.320', stable: '2.1.300', next: '2.2.0' };
  assert.equal(versionFromDistTags(tags, 'latest'), '2.1.320');
  assert.equal(versionFromDistTags(tags, 'stable'), '2.1.300');
  assert.equal(versionFromDistTags({ latest: '2.1.320' }, 'stable'), '2.1.320', 'no stable tag: latest');
  assert.equal(versionFromDistTags({ latest: 'garbage' }, 'latest'), null);
  assert.equal(versionFromDistTags('x', 'latest'), null);
});
