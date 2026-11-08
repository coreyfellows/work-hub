import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { addRevalidate, installRevalidate, pathPattern, revalidate } from './revalidate.ts';

function app() {
  const a = new Hono();
  a.use('/x', revalidate());
  a.get('/x', (c) => c.json({ n: 1 }));
  a.post('/x', (c) => c.json({ ok: true }));
  return a;
}

test('GET carries an ETag and asks the browser to revalidate', async () => {
  const r = await app().request('/x');
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('ETag'));
  assert.equal(r.headers.get('Cache-Control'), 'private, no-cache');
});

test('unchanged GET with If-None-Match → 304, no body', async () => {
  const a = app();
  const tag = (await a.request('/x')).headers.get('ETag')!;
  const r = await a.request('/x', { headers: { 'If-None-Match': tag } });
  assert.equal(r.status, 304);
  assert.equal(await r.text(), '');
});

test('POST is left alone', async () => {
  const r = await app().request('/x', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('ETag'), null);
});

test('pathPattern: :params are one segment, exact otherwise, trailing * is a prefix', () => {
  const p = pathPattern('/api/sessions/:id/run');
  assert.ok(p.test('/api/sessions/abc/run'));
  assert.ok(!p.test('/api/sessions/abc/run/1/output'));
  assert.ok(!p.test('/api/sessions/a/b/run'));
  assert.ok(pathPattern('/api/plugins/x/*').test('/api/plugins/x/a/b'));
  assert.ok(!pathPattern('/api/a.b').test('/api/aXb'));
});

test('addRevalidate + one installed middleware: listed paths get the ETag, even ones added after the routes', async () => {
  const a = new Hono();
  addRevalidate(['/r/:id']);
  installRevalidate(a);
  a.get('/r/:id', (c) => c.json({ id: c.req.param('id') }));
  a.get('/late', (c) => c.json({ late: true }));
  a.get('/other', (c) => c.json({}));
  addRevalidate(['/late']);
  assert.ok((await a.request('/r/1')).headers.get('ETag'));
  assert.ok((await a.request('/late')).headers.get('ETag'));
  assert.equal((await a.request('/other')).headers.get('ETag'), null);
});
