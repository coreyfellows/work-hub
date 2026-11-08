import test from 'node:test';
import assert from 'node:assert/strict';
import { pollFrom } from './historyPoll.ts';

test('polls a little before the end by default', () => {
  assert.equal(pollFrom(100, []), 90);
  assert.equal(pollFrom(5, []), 0);
});

test('an open question far back pulls the poll back to it', () => {
  assert.equal(pollFrom(100, [{ i: 40, questions: [{}] }, { i: 41 }]), 40);
});

test('answered questions and recent open ones do not change it', () => {
  assert.equal(pollFrom(100, [{ i: 40, questions: [{}], result: 'ok' }]), 90);
  assert.equal(pollFrom(100, [{ i: 95, questions: [{}] }]), 90);
});

test('several open questions: the oldest wins', () => {
  assert.equal(pollFrom(100, [{ i: 60, questions: [{}] }, { i: 20, questions: [{}] }]), 20);
});
