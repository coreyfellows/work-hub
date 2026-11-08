import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, rank } from './fuzzy.ts';

test('matches characters in order, case-insensitively', () => {
  assert.notEqual(fuzzyScore('wrk', 'work-hub'), null);
  assert.notEqual(fuzzyScore('WH', 'work-hub'), null);
});

test('no match returns null', () => {
  assert.equal(fuzzyScore('xyz', 'work-hub'), null);
  assert.equal(fuzzyScore('hw', 'work-hub'), null);
});

test('empty query scores 0 for anything', () => {
  assert.equal(fuzzyScore('', 'anything'), 0);
});

test('word-boundary and prefix matches beat scattered ones', () => {
  assert.ok(fuzzyScore('wh', 'work-hub')! > fuzzyScore('wh', 'awhile')!);
  assert.ok(fuzzyScore('ui', 'ui pass')! > fuzzyScore('ui', 'build pass')!);
});

test('rank orders by score and drops non-matches', () => {
  assert.deepEqual(rank(['b-ui', 'ui', 'xyz'], 'ui', (s) => s), ['ui', 'b-ui']);
});

test('rank with an empty query keeps order up to the limit', () => {
  assert.deepEqual(rank(['a', 'b', 'c'], '', (s) => s, 2), ['a', 'b']);
});

test('rank caps results at the limit', () => {
  const items = Array.from({ length: 500 }, (_, i) => `item-${i}`);
  assert.equal(rank(items, 'item', (s) => s, 30).length, 30);
  assert.equal(rank(items, 'item', (s) => s).length, 30);
});

import { multiFuzzyScore } from './fuzzy.ts';
test('multiFuzzyScore: every word must match, in any order', () => {
  assert.ok(multiFuzzyScore('view conv', 'conversation-view plugin') !== null);
  assert.equal(multiFuzzyScore('view zzz', 'conversation-view plugin'), null);
  assert.equal(multiFuzzyScore('', 'anything'), 0);
});

import { rankPreferring } from './fuzzy.ts';
test('rankPreferring: a label match beats a group-only match', () => {
  const cmds = [
    { label: 'Show Terminal', rest: 'my-session Session' },
    { label: 'New session', rest: 'Workspace' },
  ];
  const out = rankPreferring(cmds, 'session', (c) => c.label, (c) => c.rest);
  assert.equal(out[0]!.label, 'New session');
  assert.equal(out.length, 2);
});
