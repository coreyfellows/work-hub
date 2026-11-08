import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeByOrder, mergeIds } from './slotOrder.ts';

test('slot items sort among the core entries by order, default 100', () => {
  assert.deepEqual(
    mergeIds(
      [
        ['links', 10],
        ['worktrees', 30],
        ['notes', 40],
      ],
      [{ id: 'prs', order: 20 }, { id: 'late' }, { id: 'early', order: 0 }],
    ),
    ['early', 'links', 'prs', 'worktrees', 'notes', 'late'],
  );
});

test('the core wins a tie; each list keeps its own order otherwise', () => {
  assert.deepEqual(mergeIds([['core', 100]], [{ id: 'a' }, { id: 'b', order: 100 }]), ['core', 'a', 'b']);
  assert.deepEqual(mergeIds([['x', 5], ['y', 5]], []), ['x', 'y']);
});

test('mergeByOrder says where each entry came from', () => {
  const out = mergeByOrder([{ order: 1, name: 'c' }], [{ order: 0, name: 's' }]);
  assert.equal(out[0]!.slot?.name, 's');
  assert.equal(out[1]!.core?.name, 'c');
});
