import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceState } from '../registry.ts';
import { applyPatch, diffSource, isUrgent, registerUrgent, removeUrgent } from './sourceDelta.ts';

const state = (id: string, data: unknown, over: Partial<SourceState> = {}): SourceState => ({
  id,
  title: id,
  data,
  error: null,
  updatedAt: 1,
  loading: false,
  ...over,
});

const s = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  status: 'working',
  rawStatus: 'working',
  promptState: 'busy',
  needsInput: false,
  lastActiveAt: 1,
  ...over,
});

const claude = (...sessions: unknown[]) => state('claude', { sessions });
const ws = (...workspaces: unknown[]) => state('workspaces', { workspaces });

function roundTrip(prev: SourceState, next: SourceState) {
  const p = diffSource(prev, next);
  assert.ok(p, 'expected a patch');
  assert.deepEqual(applyPatch(prev, p), next);
  return p;
}

test('identical states → null', () => {
  assert.equal(diffSource(claude(s('a'), s('b')), claude(s('a'), s('b'))), null);
});

test('one session field changed → patch upserts only that session', () => {
  const p = roundTrip(claude(s('a'), s('b')), claude(s('a'), s('b', { lastActiveAt: 2 })));
  assert.ok(p.data && 'lists' in p.data);
  const l = p.data.lists.sessions;
  assert.equal(l.upsert.length, 1);
  assert.deepEqual(l.remove, []);
  assert.deepEqual(l.order, []);
});

test('session added and removed', () => {
  const p = roundTrip(claude(s('a'), s('b')), claude(s('b'), s('c')));
  assert.ok(p.data && 'lists' in p.data);
  assert.deepEqual(p.data.lists.sessions.remove, ['a']);
  assert.equal(p.data.lists.sessions.upsert.length, 1);
});

test('order-only change', () => {
  const p = roundTrip(claude(s('a'), s('b')), claude(s('b'), s('a')));
  assert.ok(p.data && 'lists' in p.data);
  assert.deepEqual(p.data.lists.sessions.upsert, []);
  assert.deepEqual(p.data.lists.sessions.order, ['b', 'a']);
});

test('keyed by id for workspaces', () => {
  roundTrip(ws({ id: 'w1', status: 'active' }), ws({ id: 'w1', status: 'parked' }, { id: 'w2', status: 'active' }));
});

test('non-keyed arrays replace whole', () => {
  const p = roundTrip(state('slack', { mentions: ['a', 'b'], n: 1 }), state('slack', { mentions: ['a', 'c'], n: 1 }));
  assert.ok(p.data && 'set' in p.data);
  assert.deepEqual(p.data.set, { mentions: ['a', 'c'] });
});

test('a key added or removed from data', () => {
  roundTrip(state('x', { a: 1 }), state('x', { b: 2 }));
});

test('null data → replace', () => {
  const p = roundTrip(state('x', null), state('x', { a: 1 }));
  assert.ok(p.data && 'replace' in p.data);
  roundTrip(state('x', { a: 1 }), state('x', null));
});

test('error and loading fields', () => {
  const p = roundTrip(claude(s('a')), state('claude', { sessions: [s('a')] }, { error: 'boom', loading: true }));
  assert.equal(p.data, undefined);
  assert.deepEqual(p.fields, { error: 'boom', loading: true });
  roundTrip(state('claude', { sessions: [s('a')] }, { error: 'boom' }), claude(s('a', { lastActiveAt: 5 })));
});

test('isUrgent: cosmetic claude change is not urgent', () => {
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { lastActiveAt: 9, detail: 'x' }))), false);
});

test('isUrgent: needsInput false→true', () => {
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { needsInput: true }))), true);
});

test('isUrgent: unread change (a session finished something you haven\'t seen)', () => {
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { unread: true }))), true);
});

test('isUrgent: promptState change', () => {
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { promptState: 'idle' }))), true);
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { waitingFor: 'permission prompt' }))), true);
});

test('isUrgent: status and rawStatus change', () => {
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { status: 'idle' }))), true);
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { rawStatus: 'blocked' }))), true);
});

test('isUrgent: session removed or added', () => {
  assert.equal(isUrgent(claude(s('a'), s('b')), claude(s('a'))), true);
  assert.equal(isUrgent(claude(s('a')), claude(s('a'), s('b'))), true);
});

test('isUrgent: workspace status change, not title', () => {
  assert.equal(isUrgent(ws({ id: 'w', status: 'active', title: 'a' }), ws({ id: 'w', status: 'parked', title: 'a' })), true);
  assert.equal(isUrgent(ws({ id: 'w', status: 'active', title: 'a' }), ws({ id: 'w', status: 'active', title: 'b' })), false);
});

test('isUrgent: other sources never', () => {
  assert.equal(isUrgent(state('github', { a: 1 }), state('github', { a: 2 })), false);
});

test('isUrgent: first state is urgent', () => {
  assert.equal(isUrgent(undefined, claude(s('a'))), true);
});

test('patches survive JSON (they go over SSE)', () => {
  const cases: [SourceState, SourceState][] = [
    [state('x', { a: 1, b: 2 }), state('x', { b: 3 })],
    [claude(s('a'), s('b')), claude(s('c'), s('a', { needsInput: true }))],
    [state('x', { a: 1 }), state('x', null)],
  ];
  for (const [prev, next] of cases) {
    const wire = JSON.parse(JSON.stringify(diffSource(prev, next)));
    assert.deepEqual(applyPatch(prev, wire), next);
  }
});

test('isUrgent: a workspace gaining a session, worktree or link (your own actions show at once)', () => {
  const w = (over: Record<string, unknown> = {}) => ws({ id: 'w', status: 'active', sessions: [], worktrees: [], links: [], events: [], ...over });
  assert.equal(isUrgent(w(), w({ sessions: [{ sessionId: 's2', role: 'worker' }] })), true);
  assert.equal(isUrgent(w(), w({ worktrees: [{ id: 't', path: '/x' }] })), true);
  assert.equal(isUrgent(w(), w({ links: [{ url: 'u' }] })), true);
  assert.equal(isUrgent(w(), w({ events: [{ kind: 'note' }] })), false);
});

test('isUrgent: a new question on a session that was already waiting', () => {
  assert.equal(isUrgent(claude(s('a', { needsInput: true, questionId: 'q1' })), claude(s('a', { needsInput: true, questionId: 'q2' }))), true);
});

test('a key that becomes undefined is cleared, as a full send would', () => {
  const prev = state('x', { a: 1, b: 2 });
  const next = state('x', { a: undefined, b: 2 });
  const wire = JSON.parse(JSON.stringify(diffSource(prev, next)));
  assert.deepEqual(applyPatch(prev, wire), JSON.parse(JSON.stringify(next)));
});

test('isUrgent: a job finishing is urgent, a job whose only change is nothing is not', () => {
  const job = (status: string) => ({ id: 'jobs', title: 'Background jobs', data: { jobs: [{ id: 'j1', status, detail: null, link: null, error: null }] }, error: null, updatedAt: 1, loading: false });
  assert.equal(isUrgent(job('running'), job('done')), true);
  assert.equal(isUrgent(job('done'), job('done')), false);
});

test('registerUrgent: a registered field becomes urgent; removeUrgent takes it back', () => {
  const items = (...xs: unknown[]) => state('plug', { items: xs });
  const a = { id: 'a', phase: 'one', noise: 1 };
  assert.equal(isUrgent(items(a), items({ ...a, phase: 'two' })), false);
  registerUrgent('plug', 'items', ['phase'], 'some-plugin');
  assert.equal(isUrgent(items(a), items({ ...a, phase: 'two' })), true);
  assert.equal(isUrgent(items(a), items({ ...a, noise: 2 })), false);
  removeUrgent('some-plugin');
  assert.equal(isUrgent(items(a), items({ ...a, phase: 'two' })), false);
});

test('registerUrgent: a second rule for the core claude source adds to it, the core fields stay', () => {
  registerUrgent('claude', 'sessions', ['lastActiveAt'], 'p2');
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { lastActiveAt: 5 }))), true);
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { status: 'idle' }))), true);
  removeUrgent('p2');
  assert.equal(isUrgent(claude(s('a')), claude(s('a', { lastActiveAt: 6 }))), false);
});
