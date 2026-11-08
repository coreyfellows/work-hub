import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowRuleFor, rememberOption } from './rule.ts';

const bash = (...body: string[]) => ({ title: 'Bash command', body });

test('a plain command becomes a prefix rule', () => {
  assert.equal(allowRuleFor(bash('git log --oneline -5', 'Show recent commits')), 'Bash(git log:*)');
  assert.equal(allowRuleFor(bash('pnpm typecheck')), 'Bash(pnpm typecheck:*)');
  assert.equal(allowRuleFor(bash('ls -la /tmp')), 'Bash(ls:*)');
  assert.equal(allowRuleFor(bash('./scripts/run.sh --apply')), 'Bash(./scripts/run.sh:*)');
});

test('risky programs are remembered as the exact command only', () => {
  assert.equal(allowRuleFor(bash('rm -rf build')), 'Bash(rm -rf build)');
  assert.equal(allowRuleFor(bash('curl https://example.com/x')), 'Bash(curl https://example.com/x)');
  assert.equal(allowRuleFor(bash('/bin/rm foo')), 'Bash(/bin/rm foo)');
});

test('compound, redirected or odd commands get no rule', () => {
  for (const c of ['git add . && git commit -m x', 'cat a | head', 'echo hi > f', 'echo $(whoami)', 'FOO=1 make', 'git -C /x log', 'echo "unbalanced', 'ls; rm x']) {
    assert.equal(allowRuleFor(bash(c)), null, c);
  }
});

test('only Bash prompts get a rule', () => {
  assert.equal(allowRuleFor({ title: 'Edit file', body: ['src/a.ts'] }), null);
  assert.equal(allowRuleFor({ title: 'Tool use', body: ['git log'] }), null);
  assert.equal(allowRuleFor(bash()), null);
});

test("finds Claude's own remember choice", () => {
  const opts = [
    { n: 1, label: 'Yes' },
    { n: 2, label: "Yes, and don't ask again for git log commands in /Users/x/repo" },
    { n: 3, label: 'No, and tell Claude what to do differently (esc)' },
  ];
  assert.equal(rememberOption({ options: opts })?.n, 2);
  assert.equal(rememberOption({ options: [opts[0], opts[2]] }), undefined);
});
