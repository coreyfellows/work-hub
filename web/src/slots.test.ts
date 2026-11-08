import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { contribute, resetSlots, slotItems, subscribeSlots } from './slots.ts';

beforeEach(() => resetSlots());

test('items sort by order (default 100), then registration order', () => {
  contribute('inline-text', { plugin: 'a', render: () => 'a1' });
  contribute('inline-text', { plugin: 'b', order: 10, render: () => 'b' });
  contribute('inline-text', { plugin: 'a', render: () => 'a2' });
  contribute('inline-text', { plugin: 'c', order: 100, render: () => 'c' });
  contribute('inline-text', { plugin: 'd', order: 200, render: () => 'd' });
  assert.deepEqual(
    slotItems('inline-text').map((i) => i.render('', '')),
    ['b', 'a1', 'a2', 'c', 'd'],
  );
});

test('slots are independent, and an unknown slot is empty', () => {
  contribute('job-kind', { plugin: 'x', kind: 'review' });
  assert.equal(slotItems('job-kind').length, 1);
  assert.deepEqual(slotItems('inline-text'), []);
  assert.deepEqual(slotItems('never-used'), []);
});

test('filtering by plugin keeps only that plugin’s items, in slot order', () => {
  contribute('job-kind', { plugin: 'x', kind: 'one', order: 50 });
  contribute('job-kind', { plugin: 'y', kind: 'two' });
  contribute('job-kind', { plugin: 'x', kind: 'three', order: 5 });
  assert.deepEqual(slotItems('job-kind', { plugin: 'x' }).map((i) => i.kind), ['three', 'one']);
  assert.deepEqual(slotItems('job-kind', { plugin: 'z' }), []);
});

test('the list is the same array until something is contributed (stable for useSyncExternalStore)', () => {
  contribute('job-kind', { plugin: 'x', kind: 'one' });
  const a = slotItems('job-kind');
  assert.equal(slotItems('job-kind'), a);
  contribute('job-kind', { plugin: 'x', kind: 'two' });
  assert.notEqual(slotItems('job-kind'), a);
  assert.equal(slotItems('job-kind').length, 2);
});

test('subscribers hear contributions; plugins may use their own slot names', () => {
  let calls = 0;
  const off = subscribeSlots(() => calls++);
  contribute('my-plugin:widgets', { plugin: 'mine', label: 'w' });
  assert.equal(calls, 1);
  off();
  contribute('my-plugin:widgets', { plugin: 'mine', label: 'v' });
  assert.equal(calls, 1);
  assert.deepEqual(slotItems('my-plugin:widgets').map((i) => i.label), ['w', 'v']);
});

test('resetSlots empties everything', () => {
  contribute('job-kind', { plugin: 'x', kind: 'one' });
  resetSlots();
  assert.deepEqual(slotItems('job-kind'), []);
});

test('plugins-action items sort by order, then registration order', () => {
  const C = () => null;
  contribute('plugins-action', { plugin: 'p', id: 'a', component: C });
  contribute('plugins-action', { plugin: 'p', id: 'b', order: 150, component: C });
  contribute('plugins-action', { plugin: 'q', id: 'c', order: 10, component: C });
  assert.deepEqual(slotItems('plugins-action').map((i) => i.id), ['c', 'a', 'b']);
});
