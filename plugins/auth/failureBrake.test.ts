import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FailureBrake, type FailureStore } from './failureBrake.ts';

const memory = (): FailureStore & { rows: number[] } => {
  const rows: number[] = [];
  return {
    rows,
    since: (t) => rows.filter((x) => x >= t),
    add: (t) => void rows.push(t),
    prune: (t) => void rows.splice(0, rows.length, ...rows.filter((x) => x >= t)),
  };
};

test('refuses after the limit within the window, and forgets old failures', () => {
  const store = memory();
  const brake = new FailureBrake(store, 3, 1000);
  for (const t of [0, 100, 200]) brake.note(t);
  assert.equal(brake.tooMany(300), true);
  assert.equal(brake.tooMany(1150), false); // the 0 and 100 failures aged out: only one left
  assert.deepEqual(store.rows, [200]);
});

test('a second brake over the same store (a restart) still remembers', () => {
  const store = memory();
  new FailureBrake(store, 2, 1000).note(10);
  new FailureBrake(store, 2, 1000).note(20);
  assert.equal(new FailureBrake(store, 2, 1000).tooMany(30), true);
});
