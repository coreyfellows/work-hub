import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CastStore } from './castStore.ts';
import { fixtureCharacter } from './fixtures.ts';
import { seedNames, seedOnce } from './seed.ts';

test('seedNames: commas or lines, trimmed, de-duplicated, at most six, each ≤ 60 chars', () => {
  assert.deepEqual(seedNames(' Ron Burgundy, a moth\nRon Burgundy,, '), ['Ron Burgundy', 'a moth']);
  assert.equal(seedNames('a,b,c,d,e,f,g,h').length, 6);
  assert.deepEqual(seedNames('x'.repeat(80)), []);
  assert.deepEqual(seedNames(''), []);
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'seed-'));
  const store = new CastStore(join(dir, 'cast.json'));
  const added: string[] = [];
  const add = (named: string, kind: 'play' | 'inspired') => (added.push(`${named}:${kind}`), { jobId: 'j' });
  return { dir, store, added, add };
}

test('seedOnce: an empty cast with first-run names generates them once, as "play"', async () => {
  const s = await setup();
  assert.equal(await seedOnce({ seed: 'Ron Burgundy, a moth', store: s.store, dir: s.dir, add: s.add }), 2);
  assert.deepEqual(s.added, ['Ron Burgundy:play', 'a moth:play']);
  // A restart doesn't start them again.
  assert.equal(await seedOnce({ seed: 'Ron Burgundy, a moth', store: s.store, dir: s.dir, add: s.add }), 0);
  assert.equal(s.added.length, 2);
});

test('seedOnce: nothing when there is no seed or the cast already has characters', async () => {
  const s = await setup();
  assert.equal(await seedOnce({ seed: '', store: s.store, dir: s.dir, add: s.add }), 0);
  await s.store.put(fixtureCharacter());
  assert.equal(await seedOnce({ seed: 'Ron', store: s.store, dir: s.dir, add: s.add }), 0);
  assert.deepEqual(s.added, []);
});

test('seedOnce: only ever the first start with a seed; editing the seed later starts nothing (review minor 2)', async () => {
  const s = await setup();
  await s.store.put(fixtureCharacter());
  // First start with a seed but a cast already there: nothing now, and never later.
  assert.equal(await seedOnce({ seed: 'Ron', store: s.store, dir: s.dir, add: s.add }), 0);
  await s.store.remove('zed');
  assert.equal(await seedOnce({ seed: 'Ron, a moth', store: s.store, dir: s.dir, add: s.add }), 0);
  assert.deepEqual(s.added, []);
});
