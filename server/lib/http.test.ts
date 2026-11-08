import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { JSON_BODY_REQUIRED, readJson } from './http.ts';

const app = new Hono();
app.post('/x', async (c) => c.json({ got: await readJson<{ a?: number }>(c) }));

const post = (body?: string) => app.request('http://h/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

test('readJson: an empty, unparsable or non-object body is a 400 JSON error, not a 500', async () => {
  for (const body of [undefined, '', 'not json', 'null', '42', '"s"', '[1]']) {
    const r = await post(body);
    assert.equal(r.status, 400, String(body));
    assert.deepEqual(await r.json(), { error: JSON_BODY_REQUIRED });
  }
});

test('readJson: a JSON object comes back as is', async () => {
  const r = await post('{"a":1}');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { got: { a: 1 } });
});
