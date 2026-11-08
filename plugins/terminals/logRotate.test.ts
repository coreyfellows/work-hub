import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { logRotator, rotateLog, rotationDue, TERMD_LOG_MAX_BYTES, TERMD_LOG_ROTATE_INTERVAL_MS } from './logRotate.ts';

test('rotateLog: leaves a small or missing log alone; a large one goes to .1 (one generation) and is emptied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-termd-log-'));
  try {
    const log = join(dir, 'termd.log');
    assert.equal(rotateLog(log, 10), false, 'missing');
    writeFileSync(log, '0123456789');
    assert.equal(rotateLog(log, 10), false, 'at the limit');
    appendFileSync(log, 'more');
    assert.equal(rotateLog(log, 10), true);
    assert.equal(readFileSync(`${log}.1`, 'utf8'), '0123456789more');
    assert.equal(statSync(log).size, 0);
    assert.equal(statSync(`${log}.1`).mode & 0o777, 0o600);
    writeFileSync(log, 'second generation');
    assert.equal(rotateLog(log, 10), true);
    assert.equal(readFileSync(`${log}.1`, 'utf8'), 'second generation', 'the older .1 is replaced');
    assert.equal(existsSync(`${log}.2`), false);
    assert.equal(TERMD_LOG_MAX_BYTES, 5 * 1024 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotateLog: a writer holding the log open in append mode keeps writing to the (emptied) log, not .1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-termd-log-'));
  try {
    const log = join(dir, 'termd.log');
    const fd = openSync(log, 'a');
    writeSync(fd, 'x'.repeat(20));
    assert.equal(rotateLog(log, 10), true);
    writeSync(fd, 'after');
    closeSync(fd);
    assert.equal(readFileSync(log, 'utf8'), 'after');
    assert.equal(readFileSync(`${log}.1`, 'utf8'), 'x'.repeat(20));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotationDue: only over the size limit, and only an interval after the last rotation', () => {
  const H = TERMD_LOG_ROTATE_INTERVAL_MS;
  assert.equal(H, 60 * 60 * 1000);
  const big = TERMD_LOG_MAX_BYTES + 1;
  assert.equal(rotationDue(TERMD_LOG_MAX_BYTES, undefined, 0), false, 'at the limit');
  assert.equal(rotationDue(big, undefined, 0), true, 'never rotated');
  assert.equal(rotationDue(big, 1000, 1000 + H - 1), false, 'a millisecond short of the interval');
  assert.equal(rotationDue(big, 1000, 1000 + H), true, 'exactly the interval');
  assert.equal(rotationDue(10, 0, 10 * H), false, 'small, however long ago');
  assert.equal(rotationDue(11, 0, 5, 10, 5), true, 'custom limit and interval');
});

test('logRotator: rotates a large log at most once per interval, seeded by the start-time rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-termd-log-'));
  try {
    const log = join(dir, 'termd.log');
    let t = 1_000_000;
    const tick = logRotator(log, { maxBytes: 10, intervalMs: 1000, rotatedAt: t, now: () => t });
    assert.equal(tick(), false, 'missing file');
    writeFileSync(log, 'x'.repeat(20));
    t += 999;
    assert.equal(tick(), false, 'too soon after the start-time rotation');
    t += 1;
    assert.equal(tick(), true);
    assert.equal(statSync(log).size, 0);
    writeFileSync(log, 'y'.repeat(20));
    t += 500;
    assert.equal(tick(), false, 'within the hour of the last one');
    assert.equal(statSync(log).size, 20);
    t += 500;
    assert.equal(tick(), true);
    assert.equal(readFileSync(`${log}.1`, 'utf8'), 'y'.repeat(20));
    t += 5000;
    assert.equal(tick(), false, 'small again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
