import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { collectIssues, overallHealth } from './health.ts';
import { contribute, resetSlots } from './slots.ts';
import type { SourceState } from './api.ts';

beforeEach(() => resetSlots());

const src = (id: string, over: Partial<SourceState> = {}): SourceState =>
  ({ id, title: id.toUpperCase(), data: null, error: null, updatedAt: null, loading: false, ...over }) as SourceState;

test('core issues: one fire per source that cannot update, nothing else without slot items', () => {
  const issues = collectIssues({ a: src('a'), b: src('b', { error: 'boom' }), health: src('health', { data: { checks: [{ ok: false, level: 'fire', label: 'x', detail: 'y' }], mcp: [] } }) });
  assert.deepEqual(issues, [{ level: 'fire', title: "B can't update", detail: 'boom' }]);
});

test('health-issues items add theirs after the core ones, in slot order, and see the sources', () => {
  contribute('health-issues', { plugin: 'late', collect: () => [{ level: 'warn', title: 'late', detail: '' }] });
  contribute('health-issues', { plugin: 'early', order: 10, collect: (s) => [{ level: 'fire', title: `early:${Object.keys(s).join(',')}`, detail: '' }] });
  const issues = collectIssues({ a: src('a', { error: 'e' }) });
  assert.deepEqual(issues.map((i) => i.title), ["A can't update", 'early:a', 'late']);
  assert.equal(overallHealth(issues, 0), 'fire');
});

test('a throwing item is skipped, not fatal', () => {
  contribute('health-issues', { plugin: 'bad', collect: () => { throw new Error('no'); } });
  contribute('health-issues', { plugin: 'ok', collect: () => [{ level: 'warn', title: 'ok', detail: '' }] });
  assert.deepEqual(collectIssues({}).map((i) => i.title), ['ok']);
  assert.equal(overallHealth(collectIssues({}), 2), 'waiting');
});

test('explicit items replace the slot (pure use)', () => {
  contribute('health-issues', { plugin: 'x', collect: () => [{ level: 'fire', title: 'slot', detail: '' }] });
  assert.deepEqual(collectIssues({}, []), []);
});
