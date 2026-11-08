import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CastStore } from './castStore.ts';
import { fixtureCharacter } from './fixtures.ts';

const fresh = async () => new CastStore(join(await mkdtemp(join(tmpdir(), 'cast-')), 'sub', 'cast.json'));

test('store: a missing file is an empty cast', async () => {
  assert.deepEqual(await (await fresh()).read(), { version: 1, characters: [] });
});

test('store: put then read', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  assert.deepEqual((await s.read()).characters.map((c) => c.id), ['zed']);
  const onDisk = JSON.parse(await readFile(s.path, 'utf8'));
  assert.equal(onDisk.characters[0].id, 'zed');
});

test('store: put replaces by id and keepPrevious enables one undo', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  await s.put(fixtureCharacter({ name: 'Zed II', updatedAt: 2 }), { keepPrevious: true });
  let [c] = (await s.read()).characters;
  assert.equal(c.name, 'Zed II');
  assert.equal(c.previous?.name, 'Zed the Lighthouse Keeper');
  const restored = await s.undo('zed');
  assert.equal(restored?.name, 'Zed the Lighthouse Keeper');
  [c] = (await s.read()).characters;
  assert.equal(c.name, 'Zed the Lighthouse Keeper');
  assert.equal(c.previous, undefined);
  assert.equal(await s.undo('zed'), null);
});

test('store: put rejects an invalid character', async () => {
  const s = await fresh();
  await assert.rejects(s.put({ ...fixtureCharacter(), color: 'nope' }));
});

test('store: remove', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  assert.equal(await s.remove('nobody'), false);
  assert.equal(await s.remove('zed'), true);
  assert.deepEqual((await s.read()).characters, []);
});

test('store: import merge skips clashes with a reason; replace drops the old cast', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  const incoming = { version: 1, characters: [fixtureCharacter({ id: 'twin' }), fixtureCharacter({ id: 'octo', emoji: '🐙' })] };
  const merged = await s.importCast(incoming, 'merge');
  assert.deepEqual(merged.added, ['octo']);
  assert.equal(merged.skipped[0].id, 'twin');
  assert.match(merged.skipped[0].reason, /emoji/);
  const replaced = await s.importCast({ version: 1, characters: [fixtureCharacter({ id: 'solo', emoji: '🎺' })] }, 'replace');
  assert.deepEqual(replaced.added, ['solo']);
  assert.deepEqual((await s.read()).characters.map((c) => c.id), ['solo']);
});

test('store: import reports characters that fail validation', async () => {
  const s = await fresh();
  const evil = fixtureCharacter();
  evil.portrait.nodes = [['script', {}]] as never;
  const r = await s.importCast({ version: 1, characters: [evil] }, 'merge');
  assert.deepEqual(r.added, []);
  assert.equal(r.skipped.length, 1);
});

test('store: a corrupt file reads as empty and is left alone until the next put', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  await writeFile(s.path, '{');
  assert.deepEqual((await s.read()).characters, []);
  assert.equal(await readFile(s.path, 'utf8'), '{');
  await s.put(fixtureCharacter({ id: 'octo', emoji: '🐙' }));
  assert.deepEqual((await s.read()).characters.map((c) => c.id), ['octo']);
});

test('store: concurrent puts both land', async () => {
  const s = await fresh();
  await Promise.all([s.put(fixtureCharacter()), s.put(fixtureCharacter({ id: 'octo', emoji: '🐙' }))]);
  assert.deepEqual((await s.read()).characters.map((c) => c.id).sort(), ['octo', 'zed']);
});

test('store: an external edit is picked up', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  await s.read();
  const other = new CastStore(s.path);
  await other.put(fixtureCharacter({ id: 'octo', emoji: '🐙' }));
  assert.equal((await s.read()).characters.length, 2);
});

test('store: a replace whose character was removed fails instead of bringing it back (review I1)', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  await s.remove('zed');
  await assert.rejects(s.put(fixtureCharacter({ name: 'Zed II' }), { mode: 'replace', keepPrevious: true }), /removed/);
  assert.deepEqual((await s.read()).characters, []);
});

test('store: a create whose id is taken fails instead of replacing (review minor 2)', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  await assert.rejects(s.put(fixtureCharacter({ emoji: '🐙', name: 'Other' }), { mode: 'create' }), /already/);
  assert.equal((await s.read()).characters[0].name, 'Zed the Lighthouse Keeper');
});

test('store: replace-import with no valid characters writes nothing (review I2)', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  await assert.rejects(s.importCast({ characters: [{ nope: 1 }] }, 'replace'), /no valid characters/);
  await assert.rejects(s.importCast({}, 'replace'), /no valid characters/);
  assert.equal((await s.read()).characters.length, 1);
});

test('store: a damaged file is backed up before the first write (review I3)', async () => {
  const s = await fresh();
  await s.put(fixtureCharacter());
  const bad = '{"version":1,"characters":[' + JSON.stringify(fixtureCharacter()) + ', {"id":"broken"';
  await writeFile(s.path, bad);
  await s.read();
  await s.put(fixtureCharacter({ id: 'octo', emoji: '🐙' }));
  const dir = (await import('node:path')).dirname(s.path);
  const backups = (await readdir(dir)).filter((f) => f.startsWith('cast.json.bad-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), bad);
});

test('store: a file with one invalid character is backed up before the next write (review I3)', async () => {
  const s = await fresh();
  await writeFile(s.path.replace(/cast\.json$/, '.keep'), '').catch(() => {});
  const { mkdir } = await import('node:fs/promises');
  await mkdir((await import('node:path')).dirname(s.path), { recursive: true });
  const raw = JSON.stringify({ version: 1, characters: [fixtureCharacter(), { ...fixtureCharacter({ id: 'bad', emoji: '🐙' }), color: 'nope' }] });
  await writeFile(s.path, raw);
  await s.put(fixtureCharacter({ id: 'octo', emoji: '🎺' }));
  const dir = (await import('node:path')).dirname(s.path);
  const backups = (await readdir(dir)).filter((f) => f.startsWith('cast.json.bad-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), raw);
});
