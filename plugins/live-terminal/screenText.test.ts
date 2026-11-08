import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeSize, readScreenText } from './screenText.ts';

test('readScreenText drops frames, the prompt and the footer, and takes the spinner word as the quip', () => {
  const screen = [
    '╭──────────╮',
    '⏺ Editing the file',
    '✻ Percolating… (12s · ↑ 340 tokens)',
    '│ >        │',
    '╰──────────╯',
    '  ? for shortcuts',
    '   ',
  ].join('\n');
  assert.deepEqual(readScreenText(screen), { lines: ['⏺ Editing the file'], quip: 'Percolating' });
});

test('changeSize counts new lines fully and lines that went at half', () => {
  assert.equal(changeSize(['same', 'gone'], ['same', 'brand new']), 'brand new'.length + 'gone'.length / 2);
  assert.equal(changeSize(['a'], ['a']), 0);
});
