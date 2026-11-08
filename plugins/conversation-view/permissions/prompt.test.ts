import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePermissionPrompt, sameLabel } from './prompt.ts';

const RULE = '─'.repeat(60);
const DASH = '╌'.repeat(60);

test('reads a tool-use permission menu', () => {
  const screen = [
    '⏺ Entering worktree(/Users/x/worktrees/work-hub/scripts-in-state)',
    '',
    RULE,
    ' Tool use',
    ' │ Creates an isolated worktree (via git or configured hooks) and switches the session into it',
    DASH,
    ' Entering worktree(/Users/x/worktrees/work-hub/scripts-in-state)',
    DASH,
    ' │ permission-root relocation to "/Users/x/worktrees/work-hub/scripts-in-state" — a model-supplied worktree',
    ' │ outside .claude/worktrees/',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
    RULE + ' Keep work-hub scripts out of /tmp ─',
  ].join('\n');
  const p = parsePermissionPrompt(screen);
  assert.ok(p);
  assert.equal(p.title, 'Tool use');
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.options, [
    { n: 1, label: 'Yes' },
    { n: 2, label: 'No' },
  ]);
  assert.equal(p.body[0], 'Creates an isolated worktree (via git or configured hooks) and switches the session into it');
  assert.ok(p.body.includes('Entering worktree(/Users/x/worktrees/work-hub/scripts-in-state)'));
});

test('joins wrapped option labels', () => {
  const screen = [
    RULE,
    ' Bash command',
    '',
    '   rm -rf build',
    '   Clean the build folder',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for rm commands in",
    '      /Users/x/repo',
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel',
  ].join('\n');
  const p = parsePermissionPrompt(screen);
  assert.ok(p);
  assert.equal(p.title, 'Bash command');
  assert.deepEqual(p.body, ['rm -rf build', 'Clean the build folder']);
  assert.equal(p.options.length, 3);
  assert.equal(p.options[1].label, "Yes, and don't ask again for rm commands in /Users/x/repo");
});

test('ignores AskUserQuestion forms and plain screens', () => {
  const ask = [RULE, ' Pick one', '', ' Which?', ' ❯ 1. A', '   2. B', '   3. Type something.', '   4. Chat about this', '', ' Enter to select · Esc to cancel'].join('\n');
  assert.equal(parsePermissionPrompt(ask), null);
  assert.equal(parsePermissionPrompt('⏺ Done.\n\n> \n? for shortcuts'), null);
});

test('sameLabel ignores wrapping', () => {
  assert.ok(sameLabel("Yes, and don't ask  again\nfor x", "Yes, and don't ask again for x"));
  assert.ok(!sameLabel('Yes', 'No'));
});
