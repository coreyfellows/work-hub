import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_REVIEWERS, parseReviewers, reviewerPrompt } from './reviewers.ts';
import { findReviewSection } from './reviewGuidance.ts';

test('parseReviewers accepts claude and command entries and fills defaults', () => {
  const r = parseReviewers({ reviewers: [{ id: 'opus', model: 'opus' }, { id: 'x', label: 'X', command: ['x', '-'], timeoutMs: 5000 }] });
  assert.equal(r[0].label, 'opus');
  assert.equal(r[0].command, null);
  assert.deepEqual(r[1].command, ['x', '-']);
  assert.equal(r[1].timeoutMs, 5000);
});

test('parseReviewers drops disabled entries but still checks their ids', () => {
  assert.equal(parseReviewers({ reviewers: [{ id: 'a', model: 'opus' }, { id: 'b', model: 'sonnet', enabled: false }] }).length, 1);
  assert.throws(() => parseReviewers({ reviewers: [{ id: 'a', model: 'opus' }, { id: 'a', model: 'sonnet', enabled: false }] }), /duplicate/);
});

test('parseReviewers rejects bad entries with a message naming them', () => {
  assert.throws(() => parseReviewers({}), /reviewers/);
  assert.throws(() => parseReviewers({ reviewers: [{ id: 'bad id', model: 'opus' }] }), /id/);
  assert.throws(() => parseReviewers({ reviewers: [{ id: 'a' }] }), /exactly one/);
  assert.throws(() => parseReviewers({ reviewers: [{ id: 'a', model: 'opus', command: ['x'] }] }), /exactly one/);
  assert.throws(() => parseReviewers({ reviewers: [{ id: 'a', command: [] }] }), /exactly one/);
  assert.throws(() => parseReviewers({ reviewers: [{ id: 'a', model: 'opus', timeoutMs: 5 }] }), /timeoutMs/);
  assert.throws(() => parseReviewers({ reviewers: [{ id: 'a', model: 'opus', enabled: false }] }), /no enabled/);
});

test('the defaults are the three Claude models', () => {
  assert.deepEqual(DEFAULT_REVIEWERS.map((r) => r.model), ['fable', 'opus', 'sonnet']);
});

test('reviewerPrompt inlines the diff only when given one', () => {
  assert.match(reviewerPrompt({ diffCommand: 'git diff main...HEAD', baseRef: 'main' }), /Get it with `git diff main\.\.\.HEAD`/);
  const inline = reviewerPrompt({ diffCommand: 'x', baseRef: 'main', inlineDiff: 'DIFFBODY' });
  assert.match(inline, /<diff>\nDIFFBODY\n<\/diff>/);
  assert.doesNotMatch(inline, /Get it with/);
});

test('findReviewSection finds a review heading and ignores fenced code', () => {
  assert.equal(findReviewSection('# Repo\n\n## Code review\n\nBe nice.'), 'Code review');
  assert.equal(findReviewSection('## Review guidelines for PRs\n'), 'Review guidelines for PRs');
  assert.equal(findReviewSection('# Repo\n## Commands\n'), null);
  assert.equal(findReviewSection('```\n## Code review\n```\n'), null);
});
