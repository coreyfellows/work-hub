import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invalidCommand } from './commandText.ts';

test('invalidCommand: one non-empty line, capped', () => {
  assert.equal(invalidCommand('ls -la'), null);
  assert.equal(invalidCommand(' '), 'command required');
  assert.equal(invalidCommand(42), 'command required');
  assert.equal(invalidCommand('a\nb'), 'command must be a single line');
  assert.equal(invalidCommand('a\tb'), 'command must be a single line');
  assert.equal(invalidCommand('x'.repeat(2000)), null);
  assert.equal(invalidCommand('x'.repeat(2001)), 'command too long');
});
