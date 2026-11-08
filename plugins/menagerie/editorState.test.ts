import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../../plugin-api/web.ts';
import { placeholders } from './editorState.ts';

const job = (id: string, status: Job['status'], over: Partial<Job> = {}): Job => ({
  id,
  kind: 'menagerie-generate',
  title: 't',
  detail: null,
  workspaceId: null,
  status,
  startedAt: 1,
  finishedAt: null,
  error: null,
  link: null,
  ...over,
});
const add = (jobId: string) => ({ jobId, named: 'a lighthouse keeper', kind: 'inspired' as const, part: 'all' as const });

test('a running add is a placeholder with its name and progress', () => {
  const [p] = placeholders({ jobs: [job('j', 'running', { detail: 'Drawing…' })], known: [add('j')], dismissed: new Set() });
  assert.equal(p.named, 'a lighthouse keeper');
  assert.equal(p.status, 'running');
  assert.equal(p.detail, 'Drawing…');
});

test('a failed add shows its error; a decline is marked', () => {
  const [p] = placeholders({ jobs: [job('j', 'failed', { error: 'declined: not comfortable' })], known: [add('j')], dismissed: new Set() });
  assert.equal(p.status, 'failed');
  assert.equal(p.declined, true);
  const [q] = placeholders({ jobs: [job('k', 'failed', { error: 'mode: one of…' })], known: [add('k')], dismissed: new Set() });
  assert.equal(q.declined, false);
});

test('finished, dismissed, unknown and other kinds of jobs give nothing', () => {
  const jobs = [job('done', 'done'), job('gone', 'failed'), job('other', 'running', { kind: 'handoff' }), job('stranger', 'running')];
  assert.deepEqual(placeholders({ jobs, known: [add('done'), add('gone'), add('other')], dismissed: new Set(['gone']) }), []);
});

test('a regenerate carries the character id', () => {
  const [p] = placeholders({ jobs: [job('j', 'running')], known: [{ ...add('j'), part: 'lines', id: 'zed' }], dismissed: new Set() });
  assert.equal(p.id, 'zed');
  assert.equal(p.part, 'lines');
});
