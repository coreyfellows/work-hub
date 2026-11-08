import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { appRules, RULES_LINES } from './rules.ts';

test('the rules carry the phrases the app depends on', () => {
  const t = appRules();
  for (const phrase of ['Do nothing', 'column 0', '`set -euo pipefail`', 'dry run', '`--apply`', '--confirm', 'AskUserQuestion', 'multiSelect', '(Recommended)'])
    assert.ok(t.includes(phrase), phrase);
  assert.ok(t.split('\n').length <= 40);
});

test('the skill carries the same rules as the fragment', () => {
  const skill = readFileSync(new URL('./claude/skills/work-hub-rules/SKILL.md', import.meta.url), 'utf8');
  for (const line of RULES_LINES.slice(2)) assert.ok(skill.includes(line), line);
});

test('every section but Vault is on by default and the text is unchanged', () => {
  assert.equal(appRules(), appRules(undefined, { commands: true, questions: true, vault: false, notes: true }));
  assert.ok(!appRules().includes('vault login'));
});

test('the Vault section when switched on', () => {
  const t = appRules(undefined, { vault: true });
  for (const phrase of ['vault login -method=oidc', 'vault token lookup']) assert.ok(t.includes(phrase), phrase);
});

test('a section switched off is left out; the others stay', () => {
  const t = appRules(undefined, { vault: false, notes: false });
  assert.ok(!t.includes('vault login'));
  assert.ok(!t.includes('make a note for me'));
  assert.ok(t.includes('AskUserQuestion') && t.includes('column 0'));
});

test('your own rules are added last, under their own heading', () => {
  const t = appRules(undefined, { extra: '  Prefer small PRs.\n    - keep indents inside\nAnswer in French.  \n' });
  const lines = t.split('\n');
  assert.deepEqual(lines.slice(-4), ['Your own rules', 'Prefer small PRs.', '    - keep indents inside', 'Answer in French.']);
});

test('nothing at all when everything is off and there are no extra rules', () => {
  assert.equal(appRules(undefined, { commands: false, questions: false, vault: false, notes: false }), '');
  assert.equal(appRules(undefined, { commands: false, questions: false, vault: false, notes: false, extra: '   ' }), '');
  assert.ok(appRules(undefined, { commands: false, questions: false, vault: false, notes: false, extra: 'x' }).includes('x'));
});
