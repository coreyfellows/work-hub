import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prChip } from './prChip.ts';
import type { PullRequest } from './types.ts';

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: 'Add a thing', url: 'https://gh/o/r/pull/7', repo: 'o/r', author: 'me', isDraft: false, mergedAt: null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', branch: 'b', reviewDecision: null, checks: 'SUCCESS',
  mergeable: 'MERGEABLE', additions: 1, deletions: 1, comments: 0, unresolvedThreads: 0, ...over,
});

test('merged wins over everything else', () => {
  assert.equal(prChip(pr({ mergedAt: '2026-11-02T00:00:00Z', checks: 'FAILURE' })).word, 'merged');
});

test('the most pressing problem is the word: conflicts, failing checks, changes requested, threads', () => {
  assert.equal(prChip(pr({ mergeable: 'CONFLICTING', checks: 'FAILURE' })).word, 'conflicts');
  assert.deepEqual([prChip(pr({ checks: 'ERROR' })).word, prChip(pr({ checks: 'ERROR' })).cls], ['checks failing', 'bad']);
  assert.equal(prChip(pr({ reviewDecision: 'CHANGES_REQUESTED', unresolvedThreads: 2 })).word, 'changes requested');
  assert.deepEqual([prChip(pr({ unresolvedThreads: 2 })).word, prChip(pr({ unresolvedThreads: 2 })).cls], ['2 unresolved', 'warn']);
});

test('then running checks, draft, approved, needs review, open', () => {
  assert.equal(prChip(pr({ checks: 'PENDING', isDraft: true })).word, 'checks running');
  assert.equal(prChip(pr({ isDraft: true })).word, 'draft');
  assert.deepEqual([prChip(pr({ reviewDecision: 'APPROVED' })).word, prChip(pr({ reviewDecision: 'APPROVED' })).cls], ['approved', 'ok']);
  assert.equal(prChip(pr({ reviewDecision: 'REVIEW_REQUIRED' })).word, 'needs review');
  assert.deepEqual([prChip(pr()).word, prChip(pr()).cls], ['open', 'ok']);
  assert.equal(prChip(pr({ checks: null })).cls, 'muted');
});

test('the tooltip names the PR and lists every fact', () => {
  assert.equal(
    prChip(pr({ isDraft: true, reviewDecision: 'CHANGES_REQUESTED', unresolvedThreads: 1, mergeable: 'CONFLICTING' })).title,
    'r#7: Add a thing (draft, checks success, changes requested, conflicts, 1 unresolved thread)',
  );
});
