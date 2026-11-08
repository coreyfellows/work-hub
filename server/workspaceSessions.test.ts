import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextPrompt, workspaceRules } from './workspaceSessions.ts';
import type { Workspace } from './store/workspaces.ts';

// The workspace context a new or review session starts with (ctx.prompts.workspaceContext), byte for byte as before
// session-tools moved out (but for the app's old name → "work-hub"); the rules part is whatever workspaceRules says (it names this checkout's `wh`).
const rules = (id: string) => workspaceRules(id).join('\n');

test('the workspace context prompt, everything filled in', async () => {
  const ws = {
    id: 'ws-1', title: 'Fix the thing', status: 'active', ticketKey: 'ABC-123', epicKey: 'ABC-1', epicTitle: 'The epic',
    prompt: 'Make it work\nacross two lines', notes: 'Plan:\n- step one\n- step two',
    worktrees: [{ id: 1, path: '/w/repo/ABC-123', repo: 'org/repo', branch: 'f-ABC-123-x', baseBranch: 'main' }, { id: 2, path: '/w/other', repo: 'org/other', branch: null, baseBranch: null }],
    links: [{ kind: 'jira', url: 'https://jira/ABC-123', label: null }, { kind: 'pr', url: 'https://gh/pr/1', label: 'PR' }],
    sessions: [{ claudeSessionId: 'nope-1', shortId: 'aaaa1111', name: 'first', role: 'main' }, { claudeSessionId: 'nope-2', shortId: 'bbbb2222', name: null, role: 'explorer' }],
  } as unknown as Workspace;
  assert.equal(await contextPrompt(ws, 'Do the task'), `You're working in the work-hub workspace "ws-1" (Fix the thing). What it's about:

- Ticket: ABC-123 (https://jira/ABC-123)
- Epic: ABC-1 (The epic)
- Original request:
  Make it work
  across two lines
- Plan and notes:
  Plan:
  - step one
  - step two
- Worktrees:
  - /w/repo/ABC-123 (org/repo @f-ABC-123-x → main)
  - /w/other (org/other @?)
- Links:
  - https://jira/ABC-123
  - PR: https://gh/pr/1
- Earlier sessions in this workspace (JSONL transcripts can be large: grep them, don't read them whole):
  - aaaa1111 "first"
  - bbbb2222 "explorer"

${rules(ws.id)}

Your task:

Do the task`);
});

test('the workspace context prompt, a bare workspace', async () => {
  const ws = { id: 'bare', title: 'Bare', status: 'active', ticketKey: null, epicKey: null, epicTitle: null, prompt: null, notes: null, worktrees: [], links: [], sessions: [] } as unknown as Workspace;
  assert.equal(await contextPrompt(ws, 'T'), `You're working in the work-hub workspace "bare" (Bare). What it's about:

- Worktrees: none recorded yet.

${rules(ws.id)}

Your task:

T`);
});
