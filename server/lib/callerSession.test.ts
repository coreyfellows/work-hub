import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callerSessionId, readJobSessionIdSync } from './callerSession.ts';

const job = (id: string) => (id === 'job1' ? 'uuid-from-job' : null);

test('explicit --session wins', () => {
  assert.equal(callerSessionId({ CLAUDE_CODE_SESSION_ID: 'u' }, job, 'x'), 'x');
});

test('a subagent is attributed to its job, not its own child session id', () => {
  assert.equal(callerSessionId({ CLAUDE_CODE_SESSION_ID: 'child', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_JOB_DIR: '/h/.claude/jobs/job1' }, job), 'uuid-from-job');
});

test('CLAUDE_CODE_SESSION_ID before the job dir', () => {
  assert.equal(callerSessionId({ CLAUDE_CODE_SESSION_ID: 'u', CLAUDE_JOB_DIR: '/h/.claude/jobs/job1' }, job), 'u');
});

test('job dir alone resolves through state.json; an unknown job is unattributed', () => {
  assert.equal(callerSessionId({ CLAUDE_JOB_DIR: '/h/.claude/jobs/job1' }, job), 'uuid-from-job');
  assert.equal(callerSessionId({ CLAUDE_JOB_DIR: '/h/.claude/jobs/nope' }, job), null);
  assert.equal(callerSessionId({}, job), null);
});

test('a subagent whose job is unknown falls back to its own session id', () => {
  assert.equal(callerSessionId({ CLAUDE_CODE_SESSION_ID: 'child', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_JOB_DIR: '/h/.claude/jobs/nope' }, job), 'child');
});

test('readJobSessionIdSync reads sessionId from state.json and is null otherwise', () => {
  const jobs = mkdtempSync(join(tmpdir(), 'wh-jobs-'));
  mkdirSync(join(jobs, 'j1'));
  writeFileSync(join(jobs, 'j1', 'state.json'), JSON.stringify({ sessionId: 'abc-123', state: 'running' }));
  mkdirSync(join(jobs, 'j2'));
  writeFileSync(join(jobs, 'j2', 'state.json'), 'not json');
  assert.equal(readJobSessionIdSync('j1', jobs), 'abc-123');
  assert.equal(readJobSessionIdSync('j2', jobs), null);
  assert.equal(readJobSessionIdSync('missing', jobs), null);
});
