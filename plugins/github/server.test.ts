/** The github plugin's POST routes with a light fake context: a missing or broken JSON body is a 400, never a 500/502. */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import register from './server.ts';

const app = new Hono();
const noop = () => {};
register({
  id: 'github',
  app,
  paths: { cacheDir: tmpdir() },
  config: { get: (_k: string, d: unknown) => d },
  services: { expose: noop },
  revalidate: noop,
  urgent: noop,
  reconcile: { addPass: noop, run: noop },
  registry: { add: noop, on: noop, refresh: async () => {} },
  jobs: { start: () => { throw new Error('no jobs in this test'); } },
  log: { info: noop, warn: noop, error: noop },
} as unknown as ServerPluginContext);

const post = (path: string, body?: string) => app.request(`http://h${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

test('POST /api/prs/session: empty or non-JSON body is 400 "JSON body required"; {} keeps its own 400', async () => {
  for (const body of [undefined, 'nope']) {
    const r = await post('/api/prs/session', body);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'JSON body required' });
  }
  const r = await post('/api/prs/session', '{}');
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'repo, branch and number required' });
});

test('PR write routes: a broken body is a 400, not a 502 from the GitHub error path', async () => {
  for (const path of ['comment', 'threads/reply', 'threads/resolve', 'merge', 'auto-merge']) {
    const r = await post(`/api/prs/o/r/1/${path}`, 'nope');
    assert.equal(r.status, 400, path);
    assert.deepEqual(await r.json(), { error: 'JSON body required' });
  }
});
