import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The store opens the database named by WORK_HUB_DB at import time, so point it at a scratch file first.
process.env.WORK_HUB_DB = join(mkdtempSync(join(tmpdir(), 'wh-events-')), 'hub.db');
const { createWorkspace, getWorkspace, listEvents, logEvent } = await import('./workspaces.ts');

test('logEvent stores the session id and listEvents filters by type and session', () => {
  createWorkspace({ id: 'w', title: 'W', origin: 'prompt' });
  logEvent('w', 'claim', 'the API', 'aaaa-1');
  logEvent('w', 'done', 'tests', 'aaaa-1');
  logEvent('w', 'claim', 'the UI', 'bbbb-2');
  logEvent('w', 'note', 'unattributed');
  assert.deepEqual(
    listEvents('w', { types: ['claim'] }).map((e) => [e.detail, e.sessionId]),
    [
      ['the UI', 'bbbb-2'],
      ['the API', 'aaaa-1'],
    ],
  );
  assert.deepEqual(
    listEvents('w', { sessionId: 'aaaa-1' }).map((e) => e.type),
    ['done', 'claim'],
  );
  assert.equal(listEvents('w', { types: ['note'] })[0].sessionId, null);
  assert.equal(listEvents('w', { limit: 1 }).length, 1);
  // hydrate reads the column too: the newest event is the unattributed note
  const ws = getWorkspace('w')!;
  assert.equal(ws.events[0].type, 'note');
  assert.equal(ws.events[0].sessionId, null);
  assert.equal(ws.events.find((e) => e.type === 'done')!.sessionId, 'aaaa-1');
});
