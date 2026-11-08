import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpGate, isSessionCapError, mcpGate } from './mcpGate.ts';

test('calls run one at a time, in order', async () => {
  const gate = createMcpGate();
  let open = 0;
  let max = 0;
  const order: number[] = [];
  const job = (n: number) => () =>
    (async () => {
      open++;
      max = Math.max(max, open);
      await new Promise((r) => setTimeout(r, 10));
      order.push(n);
      open--;
    })();
  await Promise.all([gate.run(job(1)), gate.run(job(2)), gate.run(job(3))]);
  assert.equal(max, 1);
  assert.deepEqual(order, [1, 2, 3]);
});

test('a failed call does not block the next', async () => {
  const gate = createMcpGate();
  await assert.rejects(gate.run(async () => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

test('cool-down refuses calls without running them, then lifts', async () => {
  let t = 1000;
  const gate = createMcpGate('srv', () => t);
  gate.coolDown(5000);
  let ran = false;
  await assert.rejects(gate.run(async () => { ran = true; }), /srv has too many sessions/);
  assert.equal(ran, false);
  t += 5001;
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

test('recognises the session-cap error', () => {
  assert.ok(isSessionCapError('Error POSTing to endpoint: { error : too_many_sessions , message : per-grant SDK session cap reached'));
  assert.ok(isSessionCapError('failed to connect (429)'));
  assert.ok(!isSessionCapError('slack search failed'));
});

test('one gate per server name', () => {
  assert.equal(mcpGate('a'), mcpGate('a'));
  assert.notEqual(mcpGate('a'), mcpGate('b'));
});
