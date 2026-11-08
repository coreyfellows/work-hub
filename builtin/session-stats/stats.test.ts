import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOf } from './pricing.ts';
import { computeStats } from './stats.ts';

test('costOf: list prices, cache write TTLs, [1m] suffix, unknown model', () => {
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24);
  assert.equal(costOf('claude-opus-5-5[1m]', { cache_creation_input_tokens: 1_000_000 }), 5);
  assert.equal(costOf('claude-opus-5-5', { cache_creation: { ephemeral_1h_input_tokens: 1_000_000 }, cache_read_input_tokens: 1_000_000 }), 8.2);
  assert.equal(costOf('mystery', { input_tokens: 5 }), null);
});

test('computeStats: totals, unpriced models, files newest first', () => {
  const s = computeStats(
    [
      { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } },
      { model: '', usage: { input_tokens: 1 } },
    ],
    [
      { path: '/a', at: '2026-01-01T00:00:00Z' },
      { path: '/b', at: '2026-01-02T00:00:00Z', content: 'x' },
      { path: '/a', at: '2026-01-03T00:00:00Z' },
    ],
  );
  assert.deepEqual(s.tokens, { input: 11, output: 20, cacheWrite: 30, cacheRead: 40 });
  assert.equal(s.responses, 2);
  assert.deepEqual(s.unpricedModels, ['unknown']);
  assert.ok(s.costUsd !== null && s.costUsd > 0);
  assert.deepEqual(s.files.map((f) => [f.path, f.edits, f.wrote]), [['/a', 2, false], ['/b', 1, true]]);
  assert.equal(computeStats([{ model: 'x', usage: {} }], []).costUsd, null);
});
