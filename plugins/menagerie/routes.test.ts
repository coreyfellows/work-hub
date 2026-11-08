import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { CastStore } from './castStore.ts';
import { fixtureCharacter } from './fixtures.ts';
import type { Generator } from './generate.ts';
import { registerRoutes } from './routes.ts';

const BASE = '/api/plugins/menagerie';

async function setup(gen: Partial<Generator> = {}) {
  const store = new CastStore(join(await mkdtemp(join(tmpdir(), 'routes-')), 'cast.json'));
  const calls: unknown[][] = [];
  const fake: Generator = {
    add: (...a) => (calls.push(['add', ...a]), { jobId: 'j1' }),
    regenerate: async (...a) => (calls.push(['regenerate', ...a]), { jobId: 'j2' }),
    pending: () => [],
    isBusy: () => false,
    ...gen,
  };
  const app = new Hono();
  registerRoutes(app, { gen: fake, store });
  const req = (method: string, path: string, body?: unknown) =>
    app.request(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { store, calls, req };
}

test('POST /characters starts a job (202) and validates its body', async () => {
  const { req, calls } = await setup();
  const ok = await req('POST', '/characters', { named: 'Ron Burgundy', kind: 'play', feedback: 'more hair' });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { jobId: 'j1' });
  assert.deepEqual(calls[0], ['add', 'Ron Burgundy', 'play', 'more hair']);
  assert.equal((await req('POST', '/characters', { kind: 'play' })).status, 400);
  assert.equal((await req('POST', '/characters', { named: 'x', kind: 'clone' })).status, 400);
  assert.equal((await req('POST', '/characters', { named: 'x'.repeat(61), kind: 'play' })).status, 400);
  assert.equal((await req('POST', '/characters', { named: 'x', kind: 'play', feedback: 'y'.repeat(301) })).status, 400);
  assert.equal((await req('POST', '/characters')).status, 400);
});

test('POST /characters/:id/regenerate: 202, 404 for unknown, 409 when busy, 400 for a bad part', async () => {
  const { req } = await setup();
  assert.equal((await req('POST', '/characters/zed/regenerate', { part: 'lines' })).status, 202);
  assert.equal((await req('POST', '/characters/zed/regenerate', { part: 'everything' })).status, 400);
  const unknown = await setup({ regenerate: async () => ({ error: 'unknown' }) });
  assert.equal((await unknown.req('POST', '/characters/zed/regenerate', { part: 'lines' })).status, 404);
  const busy = await setup({ regenerate: async () => ({ error: 'busy' }) });
  assert.equal((await busy.req('POST', '/characters/zed/regenerate', { part: 'lines' })).status, 409);
});

test('POST /characters/:id/undo: 404 without a previous version, 200 with one', async () => {
  const { req, store } = await setup();
  await store.put(fixtureCharacter());
  assert.equal((await req('POST', '/characters/zed/undo', {})).status, 404);
  await store.put(fixtureCharacter({ name: 'Zed II' }), { keepPrevious: true });
  const r = await req('POST', '/characters/zed/undo', {});
  assert.equal(r.status, 200);
  assert.equal((await store.read()).characters[0].name, 'Zed the Lighthouse Keeper');
});

test('DELETE /characters/:id', async () => {
  const { req, store } = await setup();
  await store.put(fixtureCharacter());
  assert.equal((await req('DELETE', '/characters/nobody')).status, 404);
  assert.equal((await req('DELETE', '/characters/zed')).status, 200);
  assert.deepEqual((await store.read()).characters, []);
});

test('GET /export downloads the cast; POST /import validates like generated output', async () => {
  const { req, store } = await setup();
  await store.put(fixtureCharacter());
  const exp = await req('GET', '/export');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition') ?? '', /attachment; filename="menagerie-cast\.json"/);
  const file = await exp.json();
  const evil = fixtureCharacter({ id: 'evil', emoji: '😈' });
  evil.portrait.nodes = [['script', {}]] as never;
  const imp = await req('POST', '/import', { cast: { version: 1, characters: [...file.characters, evil] }, mode: 'replace' });
  assert.equal(imp.status, 200);
  const body = await imp.json();
  assert.deepEqual(body.added, ['zed']);
  assert.equal(body.skipped[0].id, 'evil');
  assert.equal((await req('POST', '/import', { cast: file, mode: 'overwrite' })).status, 400);
});

test('GET /pending lists the generator\'s running jobs', async () => {
  const { req } = await setup({ pending: () => [{ jobId: 'j', named: 'x', kind: 'play', part: 'all' }] });
  assert.deepEqual(await (await req('GET', '/pending')).json(), [{ jobId: 'j', named: 'x', kind: 'play', part: 'all' }]);
});

test('POST /import replace with nothing valid is a 400 and keeps the cast (review I2)', async () => {
  const { req, store } = await setup();
  await store.put(fixtureCharacter());
  const r = await req('POST', '/import', { cast: { characters: [] }, mode: 'replace' });
  assert.equal(r.status, 400);
  assert.equal((await store.read()).characters.length, 1);
});

test('DELETE while a regenerate runs is a 409 (review I1)', async () => {
  const { req, store } = await setup({ isBusy: (id: string) => id === 'zed' });
  await store.put(fixtureCharacter());
  assert.equal((await req('DELETE', '/characters/zed')).status, 409);
  assert.equal((await store.read()).characters.length, 1);
});
