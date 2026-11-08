import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashEdits } from './bashEdits.ts';

test('bashEdits: no snapshot → [], missing after → null, unsafe ids → []', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bs-'));
  assert.deepEqual(await bashEdits(dir, 's1', 't1', null), []);
  await mkdir(join(dir, 's1'));
  await writeFile(join(dir, 's1', 't1.json'), JSON.stringify({ top: '/x', before: 'a'.repeat(40) }));
  assert.equal(await bashEdits(dir, 's1', 't1', null), null);
  assert.deepEqual(await bashEdits(dir, '../s1', 't1', null), []);
  await writeFile(join(dir, 's1', 't2.json'), JSON.stringify({ top: '/x', before: 'a'.repeat(40), after: 'a'.repeat(40) }));
  assert.deepEqual(await bashEdits(dir, 's1', 't2', null), []);
  await writeFile(join(dir, 's1', 't3.json'), JSON.stringify({ top: '/x', before: 'a'.repeat(40), after: 'b'.repeat(40), head: 'h1', headAfter: 'h2' }));
  assert.deepEqual(await bashEdits(dir, 's1', 't3', null), []);
});
