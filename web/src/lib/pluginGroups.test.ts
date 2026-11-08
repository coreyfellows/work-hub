import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPlugins } from './pluginGroups.ts';

const p = (dir: string, official = false) => ({ dir, official });

test('official plugins come first, then one group per local path', () => {
  const groups = groupPlugins([p('/r/plugins/a', true), p('/me/mine/x'), p('/me/mine/y'), p('/other/z')], ['/me/mine', '/other/z']);
  assert.deepEqual(
    groups.map((g) => [g.key, g.plugins.length]),
    [['official', 1], ['local:/me/mine', 2], ['local:/other/z', 1]],
  );
});

test('a plugin under no listed path goes to Other local; a listed empty path still shows', () => {
  const groups = groupPlugins([p('/stray/q')], ['/empty/']);
  assert.deepEqual(
    groups.map((g) => [g.key, g.plugins.length]),
    [['local:/empty/', 0], ['local-other', 1]],
  );
});

test('the longest matching path wins and a sibling prefix does not match', () => {
  const groups = groupPlugins([p('/a/b/c'), p('/a/bb/d')], ['/a', '/a/b']);
  assert.deepEqual(
    groups.map((g) => [g.key, g.plugins.length]),
    [['local:/a', 1], ['local:/a/b', 1]],
  );
});
