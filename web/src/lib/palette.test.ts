import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paletteContext, paletteMode } from './palette.ts';

test('paletteMode: a leading > lists commands, filtered by what follows', () => {
  assert.deepEqual(paletteMode('>'), { commands: true, filter: '' });
  assert.deepEqual(paletteMode('> new  '), { commands: true, filter: 'new' });
  assert.deepEqual(paletteMode('  >set'), { commands: true, filter: 'set' });
  assert.deepEqual(paletteMode('work>hub'), { commands: false, filter: 'work>hub' });
  assert.deepEqual(paletteMode(''), { commands: false, filter: '' });
});

test('paletteContext: workspace page, session page (with its owner), elsewhere', () => {
  const wss = [{ id: 'w1', sessions: [{ claudeSessionId: 'abc-123', shortId: 'abc' }] }];
  assert.deepEqual(paletteContext('/workspaces/w1', wss), { workspaceId: 'w1', sessionId: null });
  assert.deepEqual(paletteContext('/workspaces/new', wss), { workspaceId: null, sessionId: null });
  assert.deepEqual(paletteContext('/sessions/abc-123', wss), { workspaceId: 'w1', sessionId: 'abc-123' });
  assert.deepEqual(paletteContext('/sessions/abc', wss), { workspaceId: 'w1', sessionId: 'abc' });
  assert.deepEqual(paletteContext('/sessions/zzz', wss), { workspaceId: null, sessionId: 'zzz' });
  assert.deepEqual(paletteContext('/settings', wss), { workspaceId: null, sessionId: null });
  assert.deepEqual(paletteContext('/', wss), { workspaceId: null, sessionId: null });
});
