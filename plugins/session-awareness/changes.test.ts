import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeLines, seenDiff } from './claude/hooks/changes.mjs';
import type { Block } from './digest.ts';

const block = (over: Partial<Block> & { sessionId: string }): Block => ({
  shortId: over.sessionId,
  name: 'Name',
  role: 'main',
  status: 'working',
  started: 'today',
  active: 'just now',
  intent: null,
  claim: null,
  done: [],
  worktree: { path: '/w/hub/x', branch: 'feat/x', base: 'main' },
  prs: [],
  commits: [],
  files: [],
  version: `v-${over.sessionId}-${JSON.stringify(over)}`,
  ...over,
});

const self = { sessionId: 'uuid-self', shortId: 'uuid-sel' };
const now = 1_000_000_000_000;
const fresh = { stale: false, liveAt: now, now };

test('seenDiff: siblings whose version is new or changed, and siblings that left; the asker is never counted', () => {
  const blocks = [block({ sessionId: 'uuid-self' }), block({ sessionId: 'uuid-aaaa', version: 'a2' }), block({ sessionId: 'uuid-bbbb', version: 'b1' })];
  const d = seenDiff({ 'uuid-aaaa': 'a1', 'uuid-bbbb': 'b1', 'uuid-gone': 'g1', 'uuid-self': 'old' }, blocks, 'uuid-self');
  assert.deepEqual(d.changed.map((b) => b.sessionId), ['uuid-aaaa']);
  assert.deepEqual(d.gone, ['uuid-gone']);
  assert.deepEqual(seenDiff({}, blocks, 'uuid-self').changed.map((b) => b.sessionId), ['uuid-aaaa', 'uuid-bbbb']);
});

test('a new sibling, a new PR, a changed claim, a new done, a failure and an overlap each produce one line', () => {
  const prev = [
    block({ sessionId: 'uuid-aaaa', prs: [] }),
    block({ sessionId: 'uuid-bbbb', claim: 'old claim' }),
    block({ sessionId: 'uuid-cccc', done: ['one'] }),
    block({ sessionId: 'uuid-dddd', status: 'working' }),
    block({ sessionId: 'uuid-eeee', files: [{ path: 'server/x.ts', alsoBy: [] }] }),
  ];
  const next = [
    block({ sessionId: 'uuid-aaaa', prs: [{ number: 41, title: 'PR button', url: 'u', state: 'open', checks: 'PENDING' }] }),
    block({ sessionId: 'uuid-bbbb', claim: 'new claim' }),
    block({ sessionId: 'uuid-cccc', done: ['two', 'one'] }),
    block({ sessionId: 'uuid-dddd', status: 'failed' }),
    block({ sessionId: 'uuid-eeee', files: [{ path: 'server/x.ts', alsoBy: ['uuid-sel'] }] }),
    block({ sessionId: 'uuid-ffff', name: 'Newcomer', claim: 'the docs', worktree: { path: '/w/hub/docs', branch: 'docs', base: 'main' } }),
  ];
  const lines = changeLines(prev, next, self, { ...fresh, max: 10 });
  assert.deepEqual(lines, [
    'work-hub: session uuid-ffff "Newcomer" (main) started: responsible for the docs; branch docs.',
    'work-hub: session uuid-dddd "Name" failed.',
    'work-hub: session uuid-aaaa "Name" opened PR #41 "PR button" on feat/x; checks pending.',
    'work-hub: session uuid-bbbb "Name" is now responsible for: new claim.',
    'work-hub: session uuid-cccc "Name" finished: two.',
    'work-hub: session uuid-eeee "Name" edited server/x.ts, which you also edited.',
  ]);
});

test('unchanged siblings and the asker produce nothing; a vanished sibling says so; checks changes are reported', () => {
  const prev = [block({ sessionId: 'uuid-self' }), block({ sessionId: 'uuid-aaaa', prs: [{ number: 1, title: 'T', url: 'u', state: 'open', checks: 'PENDING' }] }), block({ sessionId: 'uuid-bbbb' })];
  const next = [block({ sessionId: 'uuid-self', claim: 'me' }), block({ sessionId: 'uuid-aaaa', prs: [{ number: 1, title: 'T', url: 'u', state: 'open', checks: 'FAILURE' }] })];
  assert.deepEqual(changeLines(prev, next, self, fresh), ['work-hub: session uuid-aaaa "Name" PR #1 checks now failing.', 'work-hub: session uuid-bbbb is gone (done or stopped).']);
  assert.deepEqual(changeLines(next, next, self, fresh), []);
});

test('at most `max` lines, then a trailer; stale live facts suppress status lines and add a stamp', () => {
  const next = Array.from({ length: 7 }, (_, i) => block({ sessionId: `uuid-${i}${i}${i}${i}`, claim: `thing ${i}` }));
  const lines = changeLines([], next, self, { ...fresh, max: 5 });
  assert.equal(lines.length, 6);
  assert.equal(lines[5], 'work-hub: …and 2 more changes; run the team command from your rules for the full picture.');

  const prev = [block({ sessionId: 'uuid-aaaa', status: 'working' }), block({ sessionId: 'uuid-bbbb', claim: 'a' })];
  const changed = [block({ sessionId: 'uuid-aaaa', status: 'failed' }), block({ sessionId: 'uuid-bbbb', claim: 'b' })];
  const stale = changeLines(prev, changed, self, { stale: true, liveAt: now - 7_200_000, now, max: 5 });
  assert.deepEqual(stale, ['work-hub: session uuid-bbbb "Name" is now responsible for: b.', 'work-hub: (status as of 2h ago: work-hub was idle, so session states may have moved on.)']);
  assert.deepEqual(changeLines(prev, [prev[0], changed[1]], self, { stale: true, liveAt: null, now, max: 5 }).length, 2);
});
