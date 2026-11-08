import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_REVIEWERS } from './reviewers.ts';
import { newReviewState, pendingReviewers, type ReviewState } from './review.ts';

test('a resumed review only reruns the reviewers with no outcome yet', () => {
  const st: ReviewState = newReviewState({ workspaceId: 'ws', path: '/wt' });
  st.run = {
    branch: 'b',
    baseRef: 'origin/main',
    guidance: null,
    reviewers: DEFAULT_REVIEWERS,
    reportPath: '/r.md',
    outcomes: [{ id: 'opus', label: 'Claude Opus', ok: true, text: 'x', secs: 1 }],
  };
  assert.deepEqual(pendingReviewers(st.run).map((r) => r.id), ['fable', 'sonnet']);
});

test('review state survives a JSON round trip (it is stored as a job payload)', () => {
  const st: ReviewState = { ...newReviewState({ workspaceId: null, path: null, pr: { owner: 'o', name: 'r', number: 3 } }) };
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
});
