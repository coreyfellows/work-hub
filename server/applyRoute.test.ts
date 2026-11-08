import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { isSupervised, registerApplyRoutes } from './applyRoute.ts';
import { listJobs, resetJobs } from './jobs.ts';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('isSupervised: explicit switch, the setup scripts\' WORK_HUB_REPO, or systemd', () => {
  assert.equal(isSupervised({}), false);
  assert.equal(isSupervised({ WORK_HUB_REPO: '/r' }), true);
  assert.equal(isSupervised({ INVOCATION_ID: 'x' }), true);
  assert.equal(isSupervised({ WORK_HUB_REPO: '/r', WORK_HUB_SUPERVISED: '0' }), false);
  assert.equal(isSupervised({ WORK_HUB_SUPERVISED: '1' }), true);
});

function setup(opts: { supervised: boolean; build: () => Promise<void> }) {
  resetJobs();
  const app = new Hono();
  let exits = 0;
  registerApplyRoutes(app, { repoRoot: '/r', supervised: () => opts.supervised, build: opts.build, exit: () => exits++, exitDelayMs: 5 });
  return { app, exits: () => exits };
}

test('supervised: builds, finishes the job, then exits for the supervisor to restart', async () => {
  let release!: () => void;
  const { app, exits } = setup({ supervised: true, build: () => new Promise<void>((r) => (release = r)) });
  const r = await app.request('/api/server/apply', { method: 'POST' });
  assert.equal(r.status, 202);
  const { jobId, supervised } = (await r.json()) as { jobId: string; supervised: boolean };
  assert.equal(supervised, true);
  // A second press while it builds joins the same job.
  assert.equal(((await (await app.request('/api/server/apply', { method: 'POST' })).json()) as { jobId: string }).jobId, jobId);
  assert.equal(((await (await app.request('/api/server/apply')).json()) as { jobId: string }).jobId, jobId);
  release();
  await tick();
  assert.equal(listJobs()[0]?.status, 'done');
  assert.equal(exits(), 1);
});

test('unsupervised: only builds and says to restart by hand', async () => {
  const { app, exits } = setup({ supervised: false, build: async () => {} });
  await app.request('/api/server/apply', { method: 'POST' });
  await tick();
  assert.match(listJobs()[0]?.detail ?? '', /Restart the server/);
  assert.equal(exits(), 0);
});

test('a failed build fails the job and never exits', async () => {
  const { app, exits } = setup({ supervised: true, build: async () => { throw new Error('the build failed (exit 1): boom'); } });
  await app.request('/api/server/apply', { method: 'POST' });
  await tick();
  assert.equal(listJobs()[0]?.status, 'failed');
  assert.match(listJobs()[0]?.error ?? '', /boom/);
  assert.equal(exits(), 0);
});
