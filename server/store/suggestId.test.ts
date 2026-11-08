import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, suggestId } from './workspaces.ts';

const id = (x: Parameters<typeof suggestId>[0]) => slugify(suggestId(x));

test('a ticket workspace is just its key', () => {
  assert.equal(id({ title: 'TKT-14490', ticketKey: 'TKT-14490' }), 'tkt-14490');
});

test('a ticket named in the prompt comes first, then a few meaningful words', () => {
  assert.equal(
    id({ title: 'I have tickets for TKT-13522 phase 2 - I want to verify the s' }),
    'tkt-13522-tickets-phase-verify',
  );
});

test('without a ticket: the first few meaningful words', () => {
  assert.equal(id({ title: 'Add a Ready for Review button to the PR page' }), 'add-ready-review-button');
});

test('falls back to the title when nothing is usable', () => {
  assert.equal(id({ title: '!!!' }), 'workspace');
  assert.equal(id({ title: 'to be or not' }), 'not');
});

test('a ticket key in lower case or in the middle of the title still leads', () => {
  assert.equal(id({ title: 'tkt-14490 fix login' }), 'tkt-14490-fix-login');
  assert.equal(id({ title: 'Fix the login bug (see TKT-1234)' }), 'tkt-1234-fix-login-bug');
});
