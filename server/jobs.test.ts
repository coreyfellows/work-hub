import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissJob, listJobs, registerResumer, resetJobs, setJobsListener, startJob, useJobsStore } from './jobs.ts';

const tick = () => new Promise((r) => setImmediate(r));

test('a job is running at once, then done with its link and detail', async () => {
  resetJobs();
  let release!: () => void;
  const j = startJob({ kind: 'handoff', title: 'Handing off x', workspaceId: 'ws' }, () => new Promise((r) => (release = () => r({ detail: 'ok', link: { to: '/sessions/s1', label: 'Open session' } }))));
  assert.equal(j.status, 'running');
  assert.equal(listJobs()[0]!.id, j.id);
  release();
  await tick();
  const done = listJobs()[0]!;
  assert.equal(done.status, 'done');
  assert.deepEqual(done.link, { to: '/sessions/s1', label: 'Open session' });
  assert.equal(done.detail, 'ok');
  assert.ok(done.finishedAt! >= done.startedAt);
});

test('a throwing job is failed with its message', async () => {
  resetJobs();
  startJob({ kind: 'new-session', title: 't' }, async () => {
    throw new Error('claude exploded');
  });
  await tick();
  const j = listJobs()[0]!;
  assert.equal(j.status, 'failed');
  assert.equal(j.error, 'claude exploded');
});

test('the listener hears about start and finish', async () => {
  resetJobs();
  let n = 0;
  setJobsListener(() => n++);
  startJob({ kind: 'pr-session', title: 't' }, async () => {});
  await tick();
  assert.equal(n, 2);
  setJobsListener(() => {});
});

test('newest first; dismiss removes; finished jobs expire after an hour but running ones stay', async () => {
  resetJobs();
  const a = startJob({ kind: 'handoff', title: 'a' }, async () => {});
  await tick();
  const b = startJob({ kind: 'handoff', title: 'b' }, () => new Promise(() => {}));
  assert.deepEqual(listJobs().map((j) => j.title), ['b', 'a']);
  assert.deepEqual(listJobs(Date.now() + 2 * 3600_000).map((j) => j.title), ['b']);
  dismissJob(a.id);
  assert.deepEqual(listJobs().map((j) => j.id), [b.id]);
});

test('a job can report progress while it runs', async () => {
  resetJobs();
  let release!: () => void;
  const job = startJob({ kind: 'review', title: 't' }, async (progress) => {
    progress('1 of 3 done');
    await new Promise<void>((r) => (release = r));
  });
  assert.equal(job.detail, '1 of 3 done');
  assert.equal(job.status, 'running');
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(job.status, 'done');
});

test('jobs are written through to the store, loaded back, and a running one comes back failed', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrate } = await import('./store/db.ts');
  const { sqliteJobsStore } = await import('./store/jobs.ts');
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const store = sqliteJobsStore(() => db);

  resetJobs();
  useJobsStore(store);
  const a = startJob({ kind: 'review', title: 'finished one', workspaceId: 'ws' }, async (progress) => {
    progress('2 of 3');
    return { detail: 'all done', link: { to: '/sessions/s1', label: 'Open session' } };
  });
  await tick();
  startJob({ kind: 'handoff', title: 'still running' }, () => new Promise(() => {}));
  assert.equal((db.prepare('SELECT status FROM jobs WHERE id = ?').get(a.id) as { status: string }).status, 'done');

  // "Restart": a fresh in-memory state loaded from the same database.
  resetJobs();
  useJobsStore(store);
  const byTitle = Object.fromEntries(listJobs().map((j) => [j.title, j]));
  assert.equal(byTitle['finished one']!.status, 'done');
  assert.equal(byTitle['finished one']!.detail, 'all done');
  assert.deepEqual(byTitle['finished one']!.link, { to: '/sessions/s1', label: 'Open session' });
  assert.equal(byTitle['finished one']!.workspaceId, 'ws');
  assert.equal(byTitle['still running']!.status, 'failed');
  assert.match(byTitle['still running']!.error!, /Interrupted/);
  assert.ok(byTitle['still running']!.finishedAt);

  dismissJob(a.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs WHERE id = ?').get(a.id)!.n, 0);
  resetJobs();
});

test('a running job with a payload and a resumer carries on after a restart; its payload is cleared when it finishes', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrate } = await import('./store/db.ts');
  const { sqliteJobsStore } = await import('./store/jobs.ts');
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const store = sqliteJobsStore(() => db);
  const payloadOf = (id: string) => (db.prepare('SELECT payload FROM jobs WHERE id = ?').get(id) as { payload: string | null }).payload;

  resetJobs();
  useJobsStore(store);
  const j = startJob({ kind: 'handoff', title: 'hand off', payload: { stage: 'brief' } }, (_p, ctx) => {
    ctx.setPayload({ stage: 'start' });
    return new Promise(() => {}); // the server "dies" here
  });
  assert.deepEqual(JSON.parse(payloadOf(j.id)!), { stage: 'start' });

  // Restart: the resumer gets the saved payload and finishes the job.
  resetJobs();
  let seen: unknown;
  registerResumer('handoff', async (_p, ctx) => {
    seen = ctx.payload;
    return { detail: 'resumed ok', link: { to: '/sessions/new1', label: 'Open new session' } };
  });
  useJobsStore(store);
  await tick();
  assert.deepEqual(seen, { stage: 'start' });
  const after = listJobs().find((x) => x.id === j.id)!;
  assert.equal(after.status, 'done');
  assert.equal(after.detail, 'resumed ok');
  assert.equal(payloadOf(j.id), null);
  resetJobs();
});

test('a job whose resumer fails comes back failed; a kind with no resumer is interrupted', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrate } = await import('./store/db.ts');
  const { sqliteJobsStore } = await import('./store/jobs.ts');
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const store = sqliteJobsStore(() => db);
  resetJobs();
  useJobsStore(store);
  const h = startJob({ kind: 'handoff', title: 'h', payload: { stage: 'brief' } }, () => new Promise(() => {}));
  const r = startJob({ kind: 'review', title: 'r', payload: { x: 1 } }, () => new Promise(() => {}));
  resetJobs();
  registerResumer('handoff', async () => {
    throw new Error('the session is gone');
  });
  useJobsStore(store);
  await tick();
  const byId = Object.fromEntries(listJobs().map((j) => [j.id, j]));
  assert.equal(byId[h.id]!.status, 'failed');
  assert.equal(byId[h.id]!.error, 'the session is gone');
  assert.equal(byId[r.id]!.status, 'failed');
  assert.match(byId[r.id]!.error!, /Interrupted/);
  resetJobs();
});
