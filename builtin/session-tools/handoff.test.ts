import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newHandoffState, stripBriefHeader, validHandoffModel } from './handoff.ts';

test('the saved brief file loses its header line but keeps the brief', () => {
  assert.equal(stripBriefHeader('# Handoff from abc12345 (My session)\n\n## Goal\nDo it\n'), '## Goal\nDo it');
  assert.equal(stripBriefHeader('## Goal\nno header\n'), '## Goal\nno header');
});

test('a new handoff starts at the brief stage with a trimmed note and "same" as the default model', () => {
  assert.deepEqual(newHandoffState('ws', 'sid', '  go  ', ''), { workspaceId: 'ws', sessionId: 'sid', note: 'go', model: 'same', stage: 'brief' });
});

test('handoff models', () => {
  for (const m of ['', 'same', 'auto', 'opus', 'fable']) assert.ok(validHandoffModel(m), m);
  assert.ok(!validHandoffModel('gpt'));
});
