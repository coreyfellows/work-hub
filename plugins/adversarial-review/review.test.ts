import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewerPrompt } from './reviewers.ts';
import { addressTask, reportMarkdown, type ReviewerOutcome } from './review.ts';

const outcomes: ReviewerOutcome[] = [
  { id: 'opus', label: 'Claude Opus', ok: true, text: '### [High] Bug (`a.ts:1`)', secs: 90 },
  { id: 'x', label: 'Other CLI', ok: false, text: 'exited 2: boom', secs: 3 },
];

test('the report has every reviewer, failures included', () => {
  const r = reportMarkdown({ branch: 'f-1', baseRef: 'origin/main', guidance: null, outcomes });
  assert.match(r, /## Claude Opus\n\n### \[High\] Bug/);
  assert.match(r, /## Other CLI\n\n\*\*Failed after 3s:\*\* exited 2: boom/);
  assert.match(r, /Reviewers: Claude Opus, Other CLI \(failed\)/);
});

test('the report names the guidance file when one was followed', () => {
  assert.match(reportMarkdown({ branch: 'b', baseRef: 'm', guidance: { path: 'REVIEW.md', section: null }, outcomes: [outcomes[0]] }), /guidance in `REVIEW\.md`/);
});

test('the addressing task points at the report, verifies, proposes and asks before editing, and forbids pushing', () => {
  const t = addressTask({ branch: 'f-1', baseRef: 'origin/main', worktree: '/wt', reportPath: '/r/report.md', prUrl: 'https://gh/o/r/pull/3', prHeadOid: 'abc', outcomes });
  assert.match(t, /\/r\/report\.md/);
  assert.match(t, /from Claude Opus,/);
  assert.match(t, /Other CLI \(exited 2: boom\)/);
  assert.match(t, /Verify every finding|verify every finding|Verify every/i);
  assert.match(t, /Do NOT edit anything yet/);
  assert.match(t, /AskUserQuestion/);
  assert.match(t, /"Do nothing" option/);
  assert.match(t, /exactly the changes I approved/);
  assert.match(t, /do not push/i);
  assert.match(t, /head is abc/);
});

test('reviewer prompt carries repo guidance when given', () => {
  const p = reviewerPrompt({ diffCommand: 'git diff m...HEAD', baseRef: 'm', guidance: { path: 'CLAUDE.md', section: 'Code review' } });
  assert.match(p, /`CLAUDE\.md` \(the section "Code review"\)/);
  assert.doesNotMatch(reviewerPrompt({ diffCommand: 'x', baseRef: 'm' }), /review guidance/);
});
