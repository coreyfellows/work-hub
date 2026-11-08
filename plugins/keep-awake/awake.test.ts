import test from 'node:test';
import assert from 'node:assert/strict';
import { anyWorking, createKeepAwake } from './awake.ts';

function setup(graceMs = 1000) {
  let t = 10_000;
  let acquired = 0;
  let stopped = 0;
  let lose: () => void = () => {};
  const k = createKeepAwake({
    graceMs,
    now: () => t,
    acquire: (onLost) => {
      acquired++;
      lose = onLost;
      return { stop: () => void stopped++ };
    },
  });
  return { k, tick: (ms: number) => void (t += ms), acquired: () => acquired, stopped: () => stopped, lose: () => lose() };
}

const working = [{ status: 'working' }];
const quiet = [{ status: 'idle' }, { status: 'needs-input' }, { status: 'done' }];

test('only working sessions count', () => {
  assert.equal(anyWorking(working), true);
  assert.equal(anyWorking(quiet), false);
  assert.equal(anyWorking([]), false);
});

test('nothing working: nothing is held', () => {
  const s = setup();
  assert.equal(s.k.update(quiet), false);
  assert.equal(s.acquired(), 0);
});

test('holds once while working, not once per update', () => {
  const s = setup();
  assert.equal(s.k.update(working), true);
  s.tick(500);
  assert.equal(s.k.update(working), true);
  assert.equal(s.acquired(), 1);
});

test('keeps holding through the grace period, then releases', () => {
  const s = setup(1000);
  s.k.update(working);
  s.tick(1000);
  assert.equal(s.k.update(quiet), true);
  s.tick(1);
  assert.equal(s.k.update(quiet), false);
  assert.equal(s.stopped(), 1);
});

test('a new turn inside the grace period keeps the same hold', () => {
  const s = setup(1000);
  s.k.update(working);
  s.tick(900);
  s.k.update(quiet);
  s.tick(900);
  assert.equal(s.k.update(working), true);
  assert.equal(s.acquired(), 1);
  assert.equal(s.stopped(), 0);
});

test('a hold that dies by itself is started again while still wanted', () => {
  const s = setup();
  s.k.update(working);
  s.lose();
  assert.equal(s.k.holding(), false);
  assert.equal(s.k.update(working), true);
  assert.equal(s.acquired(), 2);
});

test('stop releases', () => {
  const s = setup();
  s.k.update(working);
  s.k.stop();
  assert.equal(s.stopped(), 1);
  assert.equal(s.k.holding(), false);
});
