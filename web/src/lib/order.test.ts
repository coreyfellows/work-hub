import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, moveBefore, nudge } from './order.ts';

const D = ['a', 'b', 'c', 'd'];

test('no saved order gives the defaults', () => {
  assert.deepEqual(applyOrder(undefined, D), D);
  assert.deepEqual(applyOrder([], D), D);
});

test('saved order wins; unknown ids are dropped; missing ones keep their default relative spot at the end', () => {
  assert.deepEqual(applyOrder(['c', 'zzz', 'a'], D), ['c', 'a', 'b', 'd']);
});

test('duplicates in the saved order are ignored', () => {
  assert.deepEqual(applyOrder(['b', 'b', 'a'], D), ['b', 'a', 'c', 'd']);
});

test('nudge moves one step and stops at the ends', () => {
  assert.deepEqual(nudge(D, 'b', -1), ['b', 'a', 'c', 'd']);
  assert.deepEqual(nudge(D, 'c', 1), ['a', 'b', 'd', 'c']);
  assert.deepEqual(nudge(D, 'a', -1), D);
  assert.deepEqual(nudge(D, 'd', 1), D);
  assert.deepEqual(nudge(D, 'nope', 1), D);
});

test('moveBefore drops an item in front of another (or at the end)', () => {
  assert.deepEqual(moveBefore(D, 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveBefore(D, 'a', null), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveBefore(D, 'b', 'b'), D);
  assert.deepEqual(moveBefore(D, 'x', 'b'), D);
});
