import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusLabel, statusRank, statusTitle, waitingOnText } from './status.ts';

test('statusRank: needs-input, then warm unread, then warm, then the rest', () => {
  assert.equal(statusRank('needs-input', true), 0);
  assert.equal(statusRank('warm', true), 1);
  assert.equal(statusRank('warm', false), 2);
  assert.equal(statusRank('idle', true), 3);
  assert.equal(statusRank('working', false), 3);
});

import { workspaceBadge } from './status.ts';
test('workspaceBadge: most urgent live session, unread if any idle/warm one is', () => {
  const now = 1_000_000;
  const warm = { status: 'idle', lastActiveAt: now - 1000, unread: true };
  assert.equal(workspaceBadge([], 60_000, now), null);
  assert.deepEqual(workspaceBadge([warm, { status: 'idle', needsInput: true }], 60_000, now), { status: 'needs-input', unread: true });
  assert.deepEqual(workspaceBadge([warm], 60_000, now), { status: 'warm', unread: true });
  assert.deepEqual(workspaceBadge([{ status: 'idle', lastActiveAt: 0 }], 60_000, now), { status: 'idle', unread: false });
  assert.equal(workspaceBadge([{ status: 'done' }], 60_000, now), null);
});

import { awaitingClaude } from './status.ts';
test('awaitingClaude: your message or an unfinished tool call, but not after an interrupt', () => {
  const now = Date.parse('2026-11-05T19:42:00Z');
  const at = '2026-11-05T19:41:40Z';
  assert.equal(awaitingClaude([{ kind: 'user', at, text: 'hi' }], now), true);
  assert.equal(awaitingClaude([{ kind: 'tool', at }], now), true);
  assert.equal(awaitingClaude([{ kind: 'tool', at }, { kind: 'user', at, text: '[Request interrupted by user]' }], now), false);
  assert.equal(awaitingClaude([{ kind: 'user', at, text: '[Request interrupted by user for tool use]' }], now), false);
  assert.equal(awaitingClaude([{ kind: 'tool', at, result: 'ok' }], now), false);
  assert.equal(awaitingClaude([{ kind: 'user', at, text: '! ls', shell: { command: 'ls' } }], now), false);
  assert.equal(awaitingClaude([{ kind: 'user', at, text: '/reload-plugins', localOutput: 'Reloaded' }], now), false);
  assert.equal(awaitingClaude([{ kind: 'user', at, text: '/work-hub:scrutinize-pr' }], now), true);
  assert.equal(awaitingClaude([{ kind: 'user', at: '2026-11-05T19:30:00Z', text: 'hi' }], now), false);
  assert.equal(awaitingClaude([], now), false);
});

import { sessionRank } from './status.ts';
test('sessionRank: needs input, unread, warm, rest', () => {
  assert.deepEqual(
    [sessionRank('working', false), sessionRank('warm', false), sessionRank('idle', true), sessionRank('needs-input', true)].sort(),
    [0, 1, 2, 3],
  );
  assert.ok(sessionRank('warm', true) < sessionRank('warm', false));
});

test('a job waiting on its background tasks says so, with what it waits on', () => {
  const s = { status: 'working', waitingOnTasks: true, tasks: [{ label: 'Wait for CI checks on #3485' }] };
  assert.equal(statusLabel('working', s), 'waiting on task');
  assert.equal(waitingOnText(s), 'Wait for CI checks on #3485');
  assert.match(statusTitle(s) ?? '', /carries on when its background task finishes: Wait for CI checks on #3485/);
  assert.equal(statusLabel('working', { ...s, tasks: [{ label: 'a' }, { label: 'b' }] }), 'waiting on tasks');
  assert.equal(statusLabel('working', { ...s, waitingOnTasks: false }), 'working');
  assert.equal(waitingOnText({ ...s, status: 'needs-input' }), '');
});

test('a session only waiting on background tasks shows as "waiting": ranked with warm, unread dot like warm', async () => {
  const { sessionShownStatus, showUnread, statusRank, sessionRank, workspaceBadge } = await import('./status.ts');
  const s = { status: 'working', waitingOnTasks: true, lastActiveAt: 0 };
  assert.equal(sessionShownStatus(s, 1000, 10), 'waiting');
  assert.equal(sessionShownStatus({ ...s, waitingOnTasks: false }, 1000, 10), 'working');
  assert.equal(sessionShownStatus({ ...s, needsInput: true }, 1000, 10), 'needs-input');
  assert.equal(showUnread('waiting', true), true);
  assert.equal(showUnread('working', true), false);
  assert.equal(statusRank('waiting', true), statusRank('warm', true));
  assert.equal(statusRank('waiting', false), statusRank('warm', false));
  assert.equal(sessionRank('waiting', false), sessionRank('warm', false));
  assert.deepEqual(workspaceBadge([{ ...s, unread: true }], 1000, 10), { status: 'waiting', unread: true });
  assert.equal(workspaceBadge([s, { status: 'working' }], 1000, 10)?.status, 'working');
});
