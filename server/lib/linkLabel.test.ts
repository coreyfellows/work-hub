import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkLabel } from './linkLabel.ts';

test('linkLabel: repo#n for a PR URL (as the github plugin logs it), the URL otherwise', () => {
  assert.equal(linkLabel('https://github.example.com/org/hub/pull/12'), 'hub#12');
  assert.equal(linkLabel('https://github.com/org/hub/pull/12/'), 'hub#12');
  assert.equal(linkLabel('https://github.com/org/hub/pull/12/files'), 'https://github.com/org/hub/pull/12/files');
  assert.equal(linkLabel('https://jira.example.com/browse/ABC-1'), 'https://jira.example.com/browse/ABC-1');
});
