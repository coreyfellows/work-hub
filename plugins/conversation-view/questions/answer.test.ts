import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerKeys, screenShowsQuestion, type Question } from './answer.ts';

const ENTER = '\r';
const TAB = '\t';
const single: Question = { question: 'Pick a colour please', options: [{ label: 'Red' }, { label: 'Blue' }] };
const multi: Question = { question: 'Pick toppings', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };

test('single select types the option number', () => {
  assert.deepEqual(answerKeys([single], [{ options: [1] }], ENTER, TAB), { ok: true, chunks: ['2'] });
});

test('own text: options+1, the text on one line, Enter', () => {
  assert.deepEqual(answerKeys([single], [{ text: ' green\nish ' }], ENTER, TAB), { ok: true, chunks: ['3', 'green ish', ENTER] });
});

test('multi select toggles each (deduped) then Tab', () => {
  assert.deepEqual(answerKeys([multi], [{ options: [0, 2, 2, 9] }], ENTER, TAB), { ok: true, chunks: ['1', '3', TAB] });
});

test('more than one question adds the review submit', () => {
  const r = answerKeys([single, multi], [{ options: [0] }, { options: [1] }], ENTER, TAB);
  assert.deepEqual(r, { ok: true, chunks: ['1', '2', TAB, '1'] });
});

test('incomplete answers are refused', () => {
  assert.equal(answerKeys([single], [{ options: [] }], ENTER, TAB).ok, false);
  assert.equal(answerKeys([single], [{ options: [0, 1] }], ENTER, TAB).ok, false);
  assert.equal(answerKeys([multi], [{ options: [] }], ENTER, TAB).ok, false);
});

test('custom text refused when it would need a two-digit number', () => {
  const big: Question = { question: 'x', options: Array.from({ length: 9 }, (_, i) => ({ label: String(i) })) };
  assert.equal(answerKeys([big], [{ text: 'hi' }], ENTER, TAB).ok, false);
});

test('screen check tolerates wrapping and box drawing, and the cut-off menu', () => {
  assert.equal(screenShowsQuestion('│ Pick a colour │\n│ please │', [single]), true);
  assert.equal(screenShowsQuestion('1. Red\n2. Blue\n3. Type something\n4. Chat about this', [single]), true);
  assert.equal(screenShowsQuestion('nothing relevant here', [single]), false);
});
