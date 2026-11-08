import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspace } from '../../plugin-api/server.ts';
import { explorerPrompt, needsExplorer, ticketWorkflowRules } from './dispatch.ts';

const ws = (over: Partial<Workspace>): Workspace =>
  ({ id: 'ws-1', title: 'T', status: 'setting-up', sessions: [], worktrees: [], links: [], ticketKey: null, prompt: null, createdAt: new Date().toISOString(), ...over }) as Workspace;

test('only a fresh, empty, setting-up workspace needs its explorer started', () => {
  const now = Date.now();
  assert.equal(needsExplorer(ws({}), now), true);
  assert.equal(needsExplorer(ws({ status: 'active' }), now), false);
  assert.equal(needsExplorer(ws({ sessions: [{ claudeSessionId: 'a' } as Workspace['sessions'][number]] }), now), false);
  assert.equal(needsExplorer(ws({ createdAt: new Date(now - 20 * 60_000).toISOString() }), now), false);
});

const opts = { whCommand: '/hub/bin/wh', ticketWorkflowScripts: '/tw/scripts', fragment: '' };

test('a ticket explorer prompt names the ticket, its worktree layout, the wh commands and the epic step', () => {
  const p = explorerPrompt(ws({ ticketKey: 'TKT-123', prompt: 'extra ctx' }), opts);
  const lines = p.split('\n');
  assert.equal(lines[0], 'You\'re setting up the work-hub workspace "ws-1" for Jira ticket TKT-123, with this extra context from me:');
  assert.equal(lines[2], 'extra ctx');
  assert.ok(lines.includes('   - `git -C ~/repos/<repo> worktree add ~/worktrees/<repo>/<TKT-123> -b <branch> origin/<base>`'));
  assert.ok(p.includes('branch: `f-TKT-123-<short-desc>`'));
  assert.ok(lines.includes('   - then run `/tw/scripts/trust-worktree.sh <path>`.'));
  assert.ok(lines.includes('   - `/hub/bin/wh worktree add ws-1 --path <worktree> --base <base>` for each worktree'));
  assert.ok(p.includes('`/hub/bin/wh epic ws-1 <EPIC-KEY> "<epic title>"`'));
  assert.ok(p.includes('`/hub/bin/wh status ws-1 active`'));
  assert.equal(lines.at(-1), 'If something is ambiguous (which repo, which base branch), ask me rather than guessing.');
});

test("without the ticket-workflow scripts the explorer prompt's trust step is the core's `wh trust`", () => {
  const p = explorerPrompt(ws({ ticketKey: 'TKT-123' }), { ...opts, ticketWorkflowScripts: '' });
  assert.ok(!p.includes('trust-worktree'));
  assert.ok(p.split('\n').includes('   - then run `/hub/bin/wh trust <path>`.'));
  assert.ok(p.includes('Reuse an existing worktree'));
});

test('a prompt explorer prompt has no ticket steps; explorer fragments go last after a blank line', () => {
  const p = explorerPrompt(ws({ prompt: 'do a thing\nsecond line' }), { ...opts, fragment: 'FRAG' });
  assert.ok(p.startsWith('You\'re setting up the work-hub workspace "ws-1" for this task:\n\ndo a thing\nsecond line\n'));
  assert.ok(p.includes('1. Make sure you understand the task.'));
  assert.ok(p.includes('<short-kebab-desc>'));
  assert.ok(!p.includes(' epic '));
  assert.ok(p.endsWith('ask me rather than guessing.\n\nFRAG'));
});

test('the workspace-rules fragment carries the ticket-workflow conventions', () => {
  const t = ticketWorkflowRules({ ticketKey: 'TKT-1', worktreesDir: '/w', ticketWorkflowScripts: '/s', whCommand: '/hub/bin/wh' });
  assert.equal(
    t,
    'New worktrees follow the ticket-workflow conventions: `/w/<repo>/TKT-1`, branch `f-TKT-1-<short-desc>`, then run `/s/trust-worktree.sh <path>` on it.' +
      " Don't use `spawn-ticket-session`, cmux or other terminal workspaces, or `EnterWorktree`.",
  );
  const p = ticketWorkflowRules({ ticketKey: null, worktreesDir: '/w', ticketWorkflowScripts: '', whCommand: '/hub/bin/wh' });
  assert.ok(p.includes('`/w/<repo>/<short-kebab-desc>`, branch a short kebab-case description, then run `/hub/bin/wh trust <path>` on it.'));
  assert.ok(!p.includes('trust-worktree'));
});

test('a whCommand with a dir prefix is used as is in the explorer prompt, its trust step and the workspace rules', () => {
  const whCommand = "WORK_HUB_STATE_DIR='/x y' /hub/bin/wh";
  const p = explorerPrompt(ws({ ticketKey: 'TKT-123' }), { ...opts, whCommand, ticketWorkflowScripts: '' });
  assert.ok(p.includes(`\`${whCommand} status ws-1 active\``));
  assert.ok(p.split('\n').includes(`   - then run \`${whCommand} trust <path>\`.`));
  const r = ticketWorkflowRules({ ticketKey: null, worktreesDir: '/w', ticketWorkflowScripts: '', whCommand });
  assert.ok(r.includes(`then run \`${whCommand} trust <path>\``));
});
