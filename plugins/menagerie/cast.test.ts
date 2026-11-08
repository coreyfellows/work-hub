import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portraitErrors, slugId, toFunHost, validateCast, validateCharacter, type Character } from './cast.ts';
import { fixtureCharacter } from './fixtures.ts';

const errorsOf = (c: unknown, others?: Character[]) => {
  const r = validateCharacter(c, others);
  assert.ok(!r.ok, 'expected invalid');
  return r.errors.join('\n');
};

test('validateCharacter: the fixture round-trips', () => {
  const c = fixtureCharacter();
  const r = validateCharacter(structuredClone(c));
  assert.ok(r.ok, !r.ok ? r.errors.join() : '');
  assert.deepEqual(r.value, c);
});

const withNodes = (nodes: unknown) => ({ ...fixtureCharacter(), portrait: { nodes } });
const marked = (cls: string): unknown => ['g', { class: cls }, [['circle', { r: '1' }]]];
const mouth = (parts = ['mouth-rest', 'mouth-smile', 'mouth-o']): unknown => ['g', { class: 'mouth' }, parts.map(marked)];

test('validateCharacter: errors name the field', () => {
  const c = fixtureCharacter();
  assert.match(errorsOf({ ...c, id: 'Ron!' }), /id/);
  assert.match(errorsOf({ ...c, asks: Array(9).fill('Hi?') }), /asks/);
  assert.match(errorsOf({ ...c, color: 'red; x' }), /color/);
  assert.match(errorsOf({ ...c, mode: 'spin' }), /mode/);
  assert.match(errorsOf({ ...c, origin: { named: 'x', kind: 'clone' } }), /origin/);
  assert.match(errorsOf({ ...c, badge: 'x'.repeat(13) }), /badge/);
});

test('validateCharacter: rig marks', () => {
  assert.match(errorsOf(withNodes([marked('brows'), mouth()])), /eyes/);
  assert.match(errorsOf(withNodes([marked('eyes'), marked('shades'), mouth()])), /eyes/);
  assert.match(errorsOf(withNodes([marked('eyes'), mouth(['mouth-rest', 'mouth-smile'])])), /mouth-o/);
  assert.match(errorsOf(withNodes([marked('eyes'), marked('mouth-o')])), /mouth-o/);
  assert.match(errorsOf(withNodes([marked('eyes'), marked('prop1'), marked('prop1')])), /prop1/);
  // A moth: eyes on a flapping wing, no brows, no mouth.
  assert.ok(validateCharacter(withNodes([['g', { class: 'prop1' }, [marked('eyes-noblink')]]])).ok);
});

test('portraitErrors: generated portraits need brows and a mouth', () => {
  const moth = { nodes: [marked('eyes')] };
  assert.deepEqual(portraitErrors(moth), []);
  assert.ok(portraitErrors(moth, { complete: true }).length >= 2);
  assert.deepEqual(portraitErrors(fixtureCharacter().portrait, { complete: true }), []);
});

test('validateCharacter: hostile SVG in the portrait is rejected', () => {
  assert.match(errorsOf(withNodes([['script', {}]])), /element/);
});

test('validateCharacter: id and emoji must be unique against the others', () => {
  const other = fixtureCharacter({ id: 'other', emoji: '🗼' });
  assert.match(errorsOf(fixtureCharacter(), [other]), /emoji/);
  assert.match(errorsOf(fixtureCharacter(), [fixtureCharacter({ emoji: '🐙' })]), /id/);
});

test('validateCharacter: a gradient defined anywhere in the portrait may be used anywhere', () => {
  const nodes = [
    ['defs', {}, [['linearGradient', { id: 'sky' }, [['stop', { offset: '0', 'stop-color': '#000' }]]]]],
    ['rect', { width: '64', height: '64', fill: 'url(#sky)' }],
    ['g', { class: 'eyes' }, [['circle', { r: '1', fill: 'url(#sky)' }]]],
  ];
  assert.ok(validateCharacter(withNodes(nodes)).ok);
});

test('validateCharacter: a broken previous snapshot is dropped, not the character', () => {
  const r = validateCharacter({ ...fixtureCharacter(), previous: { nope: true } });
  assert.ok(r.ok);
  assert.equal(r.value.previous, undefined);
});

test('validateCast: anything but a cast is an empty cast', () => {
  for (const raw of ['not json-ish', null, 42, [], { characters: 'x' }]) assert.deepEqual(validateCast(raw).cast, { version: 1, characters: [] });
});

test('validateCast: keeps the good characters and lists the dropped ones', () => {
  const good = fixtureCharacter();
  const { cast, dropped } = validateCast({ version: 1, characters: [good, { ...fixtureCharacter({ id: 'bad', emoji: '🐙' }), color: 'nope' }] });
  assert.deepEqual(cast.characters.map((c) => c.id), ['zed']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, 'bad');
});

test('validateCast: a duplicate emoji later in the file is dropped', () => {
  const { cast, dropped } = validateCast({ version: 1, characters: [fixtureCharacter(), fixtureCharacter({ id: 'two' })] });
  assert.equal(cast.characters.length, 1);
  assert.match(dropped[0].errors.join(), /emoji/);
});

test('slugId: slugs and de-duplicates', () => {
  assert.equal(slugId('Mister Ed', new Set()), 'mister-ed');
  assert.equal(slugId('Mister Ed', new Set(['mister-ed'])), 'mister-ed-2');
  assert.equal(slugId('!!!', new Set()), 'host');
  assert.equal(slugId('A very long name that goes on and on forever', new Set()).length <= 24, true);
});

test('toFunHost: flattens the palette and carries the portrait', () => {
  const h = toFunHost(fixtureCharacter({ badge: 'ON AIR', rare: true }));
  assert.equal(h.id, 'zed');
  assert.deepEqual(h.letters, ['#3a86ff', '#ffbe0b']);
  assert.equal(h.text, '#f4f4f4');
  assert.equal(h.badge, 'ON AIR');
  assert.equal(h.rare, true);
  assert.ok(h.portrait.nodes.length);
  assert.equal((h as unknown as { voice?: string }).voice, undefined);
});
