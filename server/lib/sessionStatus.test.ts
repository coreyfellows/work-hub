import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundStatus, backgroundWork, runningTasks, waitingOnTasks, type BackgroundSignals } from './sessionStatus.ts';

const base: BackgroundSignals = {
  alive: true,
  agentStatus: 'idle',
  tempo: 'idle',
  jobState: 'done',
  inFlight: { tasks: 0, queued: 0, kinds: [] },
  asking: false,
  stateAt: 2000,
  lastActiveAt: 1000,
};
const st = (o: Partial<BackgroundSignals>) => backgroundStatus({ ...base, ...o });

test('a stale "blocked" while the next turn runs is working (the 3a82fa61 case)', () => {
  assert.equal(st({ jobState: 'blocked', tempo: 'blocked', agentStatus: 'busy' }), 'working');
  assert.equal(st({ jobState: 'blocked', tempo: 'active', agentStatus: 'idle' }), 'working');
});

test('background work in flight is working', () => {
  assert.equal(st({ inFlight: { tasks: 2, queued: 0, kinds: ['agent'] } }), 'working');
  assert.equal(st({ inFlight: { tasks: 0, queued: 1, kinds: [] }, jobState: 'blocked' }), 'working');
});

test('an open question or menu beats background work (the 83ce0ee4 case)', () => {
  assert.equal(st({ inFlight: { tasks: 1, kinds: ['agent'] }, asking: true, agentStatus: 'waiting' }), 'needs-input');
  assert.equal(st({ inFlight: { tasks: 0, queued: 1, kinds: [] }, asking: true, tempo: 'blocked', jobState: 'working' }), 'needs-input');
  assert.equal(st({ inFlight: { tasks: 1, kinds: ['agent'] }, agentStatus: 'waiting' }), 'needs-input');
});

test('drainable monitors alone are not work', () => {
  assert.equal(st({ inFlight: { tasks: 1, queued: 0, kinds: ['artifact_watch'], drainableMonitors: 1 } }), 'idle');
});

test('waiting on you: open question, menu, or a turn that ended asking', () => {
  assert.equal(st({ asking: true, agentStatus: 'waiting' }), 'needs-input');
  assert.equal(st({ agentStatus: 'waiting', jobState: 'working' }), 'needs-input');
  assert.equal(st({ jobState: 'blocked', tempo: 'blocked' }), 'needs-input');
});

test('a "blocked" summary older than the last message is not trusted', () => {
  assert.equal(st({ jobState: 'blocked', stateAt: 1000, lastActiveAt: 5000 }), 'idle');
});

test('idle at its prompt after a finished turn', () => {
  assert.equal(st({}), 'idle');
  assert.equal(st({ jobState: 'working', agentStatus: 'idle', tempo: 'idle' }), 'idle');
});

test('no process: the job record decides', () => {
  assert.equal(st({ alive: false, jobState: 'done' }), 'done');
  assert.equal(st({ alive: false, jobState: 'failed' }), 'failed');
  assert.equal(st({ alive: false, jobState: 'working' }), 'working');
});

test('backgroundWork counts running work', () => {
  assert.equal(backgroundWork(null), 0);
  assert.equal(backgroundWork({ tasks: 3, drainableMonitors: 1, queued: 1 }), 3);
});

test('a scheduled wakeup alone is not background work', () => {
  assert.equal(backgroundWork({ tasks: 0, kinds: ['session_cron'] }), 0);
  assert.equal(backgroundWork({ tasks: 1, kinds: ['session_cron'] }), 0);
  assert.equal(backgroundWork({ tasks: 2, kinds: ['session_cron', 'local_agent'] }), 1);
  assert.equal(backgroundWork({ tasks: 1, kinds: ['session_cron', 'local_agent'] }), 1);
  assert.equal(backgroundWork({ tasks: 1, queued: 1, kinds: ['session_cron'] }), 1);
  // The 03e8d47c case: turn over, job done, only a ScheduleWakeup fallback left.
  assert.equal(
    st({ agentStatus: 'idle', tempo: 'idle', jobState: 'done', inFlight: { tasks: 1, queued: 0, kinds: ['session_cron'] } }),
    'idle',
  );
});

test('waitingOnTasks: a working job whose turn ended, kept going by background tasks', () => {
  const base = { alive: true, status: 'working', inFlight: { tasks: 1, kinds: ['local_bash'] } };
  // claude agents says busy while a background shell runs; tempo tells the turn is over.
  assert.equal(waitingOnTasks({ ...base, agentStatus: 'busy', tempo: 'idle' }), true);
  assert.equal(waitingOnTasks({ ...base, agentStatus: 'busy', tempo: 'active' }), false);
  // No tempo: fall back to claude agents.
  assert.equal(waitingOnTasks({ ...base, agentStatus: 'idle', tempo: null }), true);
  assert.equal(waitingOnTasks({ ...base, agentStatus: 'busy', tempo: null }), false);
  assert.equal(waitingOnTasks({ ...base, agentStatus: 'busy', tempo: 'idle', inFlight: { tasks: 0 } }), false);
  assert.equal(waitingOnTasks({ ...base, agentStatus: 'busy', tempo: 'idle', status: 'needs-input' }), false);
  assert.equal(waitingOnTasks({ ...base, agentStatus: 'busy', tempo: 'idle', alive: false }), false);
});

test('runningTasks: running ones only, described by their call when known, clipped', () => {
  const fan = [
    { id: 'bu7', kind: 'shell', label: 'sleep 20; $CLAUDE_JOB_DIR/tmp/wait-checks.sh', startedAt: 1 },
    { id: 'a1', kind: 'agent', label: 'Explore the deploy setup', startedAt: 1 },
    { id: 'a2', kind: 'agent', label: 'Finished one', startedAt: 1, doneAt: 2 },
    { id: 'todo:1', kind: 'todo', label: 'Task 1' },
    { id: 'b9', kind: 'shell', label: `for i in $(seq 1 50); do\n  ${'x'.repeat(100)}` },
  ];
  const got = runningTasks(fan, new Map([['bu7', { description: 'Wait for CI checks on #3485' }]]));
  assert.deepEqual(got.slice(0, 2), [
    { id: 'bu7', kind: 'shell', label: 'Wait for CI checks on #3485', startedAt: 1 },
    { id: 'a1', kind: 'agent', label: 'Explore the deploy setup', startedAt: 1 },
  ]);
  assert.equal(got.length, 3);
  assert.ok(got[2]!.label.startsWith('for i in $(seq 1 50); do x') && got[2]!.label.endsWith('…') && got[2]!.label.length === 80);
  assert.deepEqual(runningTasks(undefined), []);
});
