import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardCounts } from './workspaceCard.ts';
import type { Session } from './api.ts';

const s = (over: Partial<Session>): Session => ({ status: 'idle', needsInput: false, unread: false, lastActiveAt: null, ...over }) as Session;

test('counts waiting, really working and unread sessions, and the latest activity', () => {
  const c = cardCounts([
    s({ needsInput: true, status: 'waiting', unread: true, lastActiveAt: 10 }),
    s({ status: 'working', lastActiveAt: 30 }),
    s({ status: 'working', waitingOnTasks: true, lastActiveAt: 20 }),
    s({ status: 'idle', unread: true }),
    s({ status: 'idle' }),
  ]);
  assert.deepEqual(c, { waiting: 1, working: 1, unread: 1, lastActiveAt: 30 });
});

test('no sessions: all zero', () => {
  assert.deepEqual(cardCounts([]), { waiting: 0, working: 0, unread: 0, lastActiveAt: 0 });
});
