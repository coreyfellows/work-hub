import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Block } from './digest.ts';
import { checksMark, dotClass, glanceOrder, hasSiblings, shortPath, staleLine } from './glance.ts';

const b = (sessionId: string, status: string): Block =>
  ({ sessionId, shortId: sessionId, name: null, role: 'main', status, started: 'today', active: null, intent: null, claim: null, done: [], worktree: null, prs: [], commits: [], files: [], version: 'v' }) as Block;

test('glanceOrder: working, waiting, idle, others, failed; ties by short id', () => {
  const out = glanceOrder([b('z-idle', 'idle'), b('b-fail', 'failed'), b('c-work', 'working'), b('a-work', 'working'), b('d-wait', 'needs-input'), b('e-unk', 'unknown')]);
  assert.deepEqual(out.map((x) => x.sessionId), ['a-work', 'c-work', 'd-wait', 'z-idle', 'e-unk', 'b-fail']);
});

test('staleLine: null when fresh or under the threshold, a sentence when over, a different one when never refreshed', () => {
  const now = 1_000_000_000_000;
  assert.equal(staleLine(now - 1000, now), null);
  assert.equal(staleLine(now - 599_000, now), null);
  assert.equal(staleLine(now - 7_200_000, now), 'Status and PR facts as of 2h ago: work-hub was idle.');
  assert.equal(staleLine(null, now), 'Status and PR facts not refreshed yet: work-hub has been idle.');
  assert.equal(staleLine(now - 61_000, now, 60_000), 'Status and PR facts as of 1m ago: work-hub was idle.');
});

test('dotClass and checksMark map statuses and checks to the core classes', () => {
  assert.equal(dotClass('working'), 'sa-dot working');
  assert.equal(dotClass('needs-input'), 'sa-dot waiting');
  assert.equal(dotClass('failed'), 'sa-dot failed');
  assert.equal(dotClass('idle'), 'sa-dot idle');
  assert.deepEqual(checksMark('SUCCESS'), ['✓', 'ok', 'checks passing']);
  assert.deepEqual(checksMark('FAILURE'), ['✗', 'bad', 'checks failing']);
  assert.deepEqual(checksMark('PENDING'), ['●', 'pending', 'checks running']);
  assert.equal(checksMark(null), null);
});

test('hasSiblings: needs two recorded sessions that are live and not done/stopped', () => {
  const rec = (id: string) => ({ claudeSessionId: id });
  const live = [{ sessionId: 'a', status: 'working' }, { sessionId: 'b', status: 'idle' }, { sessionId: 'c', status: 'done' }, { sessionId: 'd', status: 'stopped' }];
  assert.equal(hasSiblings([rec('a'), rec('b')], live), true);
  assert.equal(hasSiblings([rec('a'), rec('c')], live), false, 'one live, one done');
  assert.equal(hasSiblings([rec('a'), rec('d'), rec('gone')], live), false, 'stopped and unknown do not count');
  assert.equal(hasSiblings([rec('a'), rec('b')], []), false);
});

test('shortPath: …/ plus the last two segments for a long path, the path itself when short', () => {
  assert.equal(shortPath('/Users/me/worktrees/work-hub/feat-x'), '…/work-hub/feat-x');
  assert.equal(shortPath('/w/hub/a'), '…/hub/a');
  assert.equal(shortPath('/w/a'), '/w/a');
  assert.equal(shortPath('/a'), '/a');
  assert.equal(shortPath('C:/Users/me/repo/x/'), '…/repo/x');
  assert.equal(shortPath('/Users/me/worktrees/work-hub/feat-x/'), '…/work-hub/feat-x');
});
