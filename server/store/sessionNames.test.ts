import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WORK_HUB_STATE_DIR = mkdtempSync(join(tmpdir(), 'wh-names-'));
const { sessionNames, setSessionName } = await import('./sessionNames.ts');
const { createWorkspace, getWorkspace, updateWorkspace } = await import('./workspaces.ts');

test('a session name is stored, replaced and cleared by an empty name', () => {
  setSessionName('s1', '  Fix login  ');
  assert.equal(sessionNames().get('s1'), 'Fix login');
  setSessionName('s1', 'Fix signup');
  assert.equal(sessionNames().get('s1'), 'Fix signup');
  setSessionName('s1', '   ');
  assert.equal(sessionNames().has('s1'), false);
});

test('renaming a workspace changes its title', () => {
  const id = createWorkspace({ title: 'Old title', origin: 'prompt' });
  updateWorkspace(id, { title: 'New title' });
  assert.equal(getWorkspace(id)?.title, 'New title');
});
