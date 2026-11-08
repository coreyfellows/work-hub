import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceState } from '../registry.ts';
import { applyPatch, type SourcePatch } from './sourceDelta.ts';
import { SourceStream } from './sourceStream.ts';

const st = (id: string, data: unknown): SourceState => ({ id, title: id, data, error: null, updatedAt: 1, loading: false });

function collect() {
  const out: { event: string; data: unknown }[] = [];
  const stream = new SourceStream((event, data) => out.push({ event, data: JSON.parse(data) }));
  return { out, stream };
}

test('first state per source is sent whole', () => {
  const { out, stream } = collect();
  stream.change(st('a', { n: 1 }));
  assert.deepEqual(out, [{ event: 'source', data: st('a', { n: 1 }) }]);
});

test('later changes are sent as patches that rebuild the state', () => {
  const { out, stream } = collect();
  stream.change(st('a', { n: 1 }));
  stream.change(st('a', { n: 2 }));
  assert.equal(out[1].event, 'source-patch');
  assert.deepEqual(applyPatch(out[0].data as SourceState, out[1].data as SourcePatch), st('a', { n: 2 }));
});

test('no-op change sends nothing', () => {
  const { out, stream } = collect();
  stream.change(st('a', { n: 1 }));
  stream.change(st('a', { n: 1 }));
  assert.equal(out.length, 1);
});

// --- low-data connections: non-urgent changes at most once per batchMs per source, urgent ones at once ---

const claude = (needsInput: boolean, lastActiveAt: number): SourceState =>
  st('claude', { sessions: [{ sessionId: 's1', status: 'working', rawStatus: 'working', promptState: 'busy', needsInput, lastActiveAt }] });

function collectLow(t: { mock: { timers: { enable(o: unknown): void } } }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const out: { event: string; data: unknown }[] = [];
  const stream = new SourceStream((event, data) => out.push({ event, data: JSON.parse(data) }), { batchMs: 10_000 });
  return { out, stream };
}

test('low: first state goes out at once', (t) => {
  const { out, stream } = collectLow(t);
  stream.change(claude(false, 1));
  assert.equal(out.length, 1);
});

test('low: a cosmetic change waits for the batch window, then sends the latest', (t) => {
  const { out, stream } = collectLow(t);
  stream.change(claude(false, 1));
  t.mock.timers.tick(3_000);
  stream.change(claude(false, 2));
  stream.change(claude(false, 3));
  assert.equal(out.length, 1);
  t.mock.timers.tick(6_999);
  assert.equal(out.length, 1);
  t.mock.timers.tick(1);
  assert.equal(out.length, 2);
  assert.deepEqual(applyPatch(out[0].data as SourceState, out[1].data as SourcePatch), claude(false, 3));
});

test('low: an urgent change goes out at once and carries the batched ones', (t) => {
  const { out, stream } = collectLow(t);
  stream.change(claude(false, 1));
  t.mock.timers.tick(1_000);
  stream.change(claude(false, 2));
  stream.change(claude(true, 3));
  assert.equal(out.length, 2);
  assert.deepEqual(applyPatch(out[0].data as SourceState, out[1].data as SourcePatch), claude(true, 3));
  t.mock.timers.tick(20_000);
  assert.equal(out.length, 2, 'the pending batch was cancelled');
});

test('low: a cosmetic change after a quiet spell goes out at once', (t) => {
  const { out, stream } = collectLow(t);
  stream.change(claude(false, 1));
  t.mock.timers.tick(15_000);
  stream.change(claude(false, 2));
  assert.equal(out.length, 2);
});

test('low: close drops pending batches', (t) => {
  const { out, stream } = collectLow(t);
  stream.change(claude(false, 1));
  stream.change(claude(false, 2));
  stream.close();
  t.mock.timers.tick(20_000);
  assert.equal(out.length, 1);
});
